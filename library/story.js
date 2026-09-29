// Story (WhatsApp status) helper.
// - keeps the list of people who can see your story (your contacts)
// - posts media to status@broadcast WITHOUT re-encoding, so quality stays as-is

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const config = () => require('../settings/config');
const FILE = path.join(__dirname, 'database', 'story-audience.json');

const audience = new Set();
try {
    for (const jid of JSON.parse(fs.readFileSync(FILE, 'utf8'))) audience.add(jid);
} catch {}

let saveTimer = null;
const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.writeFile(FILE, JSON.stringify([...audience]), () => {});
    }, 3000);
};

// accepts "6285..@s.whatsapp.net", "6285..:12@s.whatsapp.net" or bare digits
const toPnJid = (v) => {
    if (typeof v !== 'string') return null;
    if (/^\d{6,}$/.test(v)) return v + '@s.whatsapp.net';
    if (!v.endsWith('@s.whatsapp.net')) return null;
    return v.split('@')[0].split(':')[0] + '@s.whatsapp.net';
};

const add = (...candidates) => {
    for (const c of candidates) {
        const jid = toPnJid(c);
        if (jid && !audience.has(jid)) {
            audience.add(jid);
            scheduleSave();
        }
    }
};

const addContact = (c) => c && add(c.phoneNumber, c.id);

const bind = (sock) => {
    sock.ev.on('messaging-history.set', ({ contacts = [] }) => contacts.forEach(addContact));
    sock.ev.on('contacts.upsert', (list) => list.forEach(addContact));
    sock.ev.on('contacts.update', (list) => list.forEach(addContact));

    if (config().story?.includeChatPartners) {
        sock.ev.on('messages.upsert', ({ messages }) => {
            for (const mk of messages) {
                const k = mk.key || {};
                if (k.remoteJid && !k.remoteJid.endsWith('@g.us') && k.remoteJid !== 'status@broadcast') {
                    add(k.remoteJidAlt, k.remoteJid);
                }
            }
        });
    }
};

// Split a video into consecutive parts WITHOUT re-encoding (stream copy = no quality loss).
// Cuts land on keyframes, so each part is slightly under the limit (2s safety margin).
// Order: config.story.ffmpegPath -> system "ffmpeg" (if it runs) -> bundled @ffmpeg-installer binary.
let ffmpegCache = null;
const ffmpegPath = () => {
    if (ffmpegCache) return ffmpegCache;
    const { spawnSync } = require('child_process');
    const works = (bin) => {
        try { return spawnSync(bin, ['-version'], { timeout: 8000 }).status === 0; } catch { return false; }
    };
    const candidates = [config().story?.ffmpegPath, 'ffmpeg'].filter(Boolean);
    try { candidates.push(require('@ffmpeg-installer/ffmpeg').path); } catch {}
    for (const bin of candidates) {
        if (works(bin)) return (ffmpegCache = bin);
    }
    throw new Error('No working ffmpeg found (tried: ' + candidates.join(', ') + ')');
};

const splitVideo = async (buffer, segmentSeconds) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-'));
    const input = path.join(dir, 'input.mp4');
    try {
        await fs.promises.writeFile(input, buffer);
        const segTime = Math.max(5, segmentSeconds - 2);
        await new Promise((resolve, reject) => {
            const bin = ffmpegPath();
            const p = spawn(bin, [
                '-y', '-i', input,
                '-map', '0:v:0', '-map', '0:a?',
                '-c', 'copy',
                '-f', 'segment', '-segment_time', String(segTime),
                '-reset_timestamps', '1',
                '-segment_format_options', 'movflags=+faststart',
                path.join(dir, 'part_%03d.mp4')
            ]);
            let err = '';
            p.stderr.on('data', (d) => (err += d));
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ` + err.trim().split('\n').slice(-4).join(' | ').slice(-400)))));
        });
        const files = (await fs.promises.readdir(dir)).filter((f) => f.startsWith('part_')).sort();
        const parts = [];
        for (const f of files) parts.push(await fs.promises.readFile(path.join(dir, f)));
        return parts;
    } finally {
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

// Convert any video container (mov, mkv...) to ONE mp4 WITHOUT re-encoding:
// full length, same resolution, same quality (stream copy).
const remuxVideo = async (buffer) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-'));
    const input = path.join(dir, 'input.bin');
    const output = path.join(dir, 'output.mp4');
    try {
        await fs.promises.writeFile(input, buffer);
        await new Promise((resolve, reject) => {
            const p = spawn(ffmpegPath(), [
                '-y', '-i', input,
                '-map', '0:v:0', '-map', '0:a?',
                '-c', 'copy',
                '-movflags', '+faststart',
                output
            ]);
            let err = '';
            p.stderr.on('data', (d) => (err += d));
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ` + err.trim().split('\n').slice(-4).join(' | ').slice(-400)))));
        });
        return await fs.promises.readFile(output);
    } finally {
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

const ownJid = (sock) => sock.user.id.split('@')[0].split(':')[0] + '@s.whatsapp.net';

const getAudience = (sock) => [...new Set([ownJid(sock), ...audience])];

// buffer must be the ORIGINAL bytes (no resize / re-encode)
const postStory = async (sock, { buffer, mimetype, caption }) => {
    const isVideo = /^video\//.test(mimetype);
    const content = isVideo ? { video: buffer, mimetype } : { image: buffer, mimetype };
    if (caption) content.caption = caption;

    const statusJidList = getAudience(sock);
    await sock.sendMessage('status@broadcast', content, { statusJidList });
    return { recipients: statusJidList.length };
};

module.exports = { bind, add, getAudience, postStory, splitVideo, remuxVideo, audienceSize: () => audience.size };
