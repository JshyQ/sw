// Story (WhatsApp status) helper.
// - keeps the list of people who can see your story (your contacts)
// - posts media to status@broadcast WITHOUT re-encoding, so quality stays as-is

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const config = () => require('../settings/config');
const FILE = path.join(__dirname, 'database', 'story-audience.json');
const POSTED_FILE = path.join(__dirname, 'database', 'story-posted.json');

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

// Keys of stories we've posted (so we can delete them later, e.g. "delete all my stories").
// Each entry: { id, participant, timestamp }. Cleared as entries are successfully deleted.
let posted = [];
try {
    posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8'));
    if (!Array.isArray(posted)) posted = [];
} catch {}

const savePosted = () => {
    fs.writeFile(POSTED_FILE, JSON.stringify(posted), () => {});
};

const recordPosted = (key) => {
    if (!key || !key.id) return;
    posted.push({ id: key.id, participant: key.participant || null, timestamp: Date.now() });
    savePosted();
};

const listPosted = () => [...posted];

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

// Re-encode to a much smaller mp4 while KEEPING the resolution (no scaling) and full duration.
// opts: crf (higher = smaller, 18-40), preset, audioKbps, maxFps (0 = keep original fps)
const compressVideo = async (buffer, opts = {}) => {
    const { crf = 32, preset = 'medium', audioKbps = 96, maxFps = 0 } = opts;
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-'));
    const input = path.join(dir, 'input.bin');
    const output = path.join(dir, 'output.mp4');
    try {
        await fs.promises.writeFile(input, buffer);
        const args = [
            '-y', '-i', input,
            '-map', '0:v:0', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
            '-pix_fmt', 'yuv420p'
        ];
        if (maxFps > 0) args.push('-fpsmax', String(maxFps));
        args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', output);
        await new Promise((resolve, reject) => {
            const p = spawn(ffmpegPath(), args);
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
    const sent = await sock.sendMessage('status@broadcast', content, { statusJidList });
    if (sent?.key) recordPosted(sent.key);
    return { recipients: statusJidList.length, key: sent?.key };
};

// Deletes every story we have a record of posting. Best-effort: keeps whatever fails
// so a retry doesn't re-delete already-gone entries and doesn't lose track of stuck ones.
const deleteAllStories = async (sock) => {
    const statusJidList = getAudience(sock);
    const remaining = [];
    let ok = 0;
    let failed = 0;
    for (const entry of posted) {
        try {
            const key = {
                remoteJid: 'status@broadcast',
                id: entry.id,
                fromMe: true,
                ...(entry.participant ? { participant: entry.participant } : {})
            };
            await sock.sendMessage('status@broadcast', { delete: key }, { statusJidList });
            ok++;
        } catch (e) {
            failed++;
            remaining.push(entry);
        }
    }
    posted = remaining;
    savePosted();
    return { deleted: ok, failed };
};

module.exports = {
    bind, add, getAudience, postStory, splitVideo, remuxVideo, compressVideo,
    audienceSize: () => audience.size,
    listPosted, deleteAllStories
};
