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
    if (posted.some((e) => e.id === key.id)) return; // dedupe (bot post + upsert echo, etc.)
    posted.push({ id: key.id, participant: key.participant || null, timestamp: Date.now() });
    savePosted();
};

const listPosted = () => [...posted];

// Catches stories posted from ANY device on this account (phone, WhatsApp Web, another bot
// session...) while this bot is connected, plus any recent ones replayed during the initial
// history sync on login. WhatsApp has no API to list "my currently active stories" on demand,
// so this passive capture is the only way to know what's deletable later via delstory.
const trackAllOwnStories = (sock) => {
    const capture = (msg) => {
        if (msg?.key?.remoteJid === 'status@broadcast' && msg.key.fromMe) recordPosted(msg.key);
    };
    sock.ev.on('messages.upsert', ({ messages = [] }) => messages.forEach(capture));
    sock.ev.on('messaging-history.set', ({ messages = [] }) => messages.forEach(capture));
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

    trackAllOwnStories(sock);

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

// Runs ffmpeg, resolves with stderr text, rejects with a short reason on failure.
const runFfmpeg = (args) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited with code ${code}: ` + err.trim().split('\n').slice(-4).join(' | ').slice(-400)))));
});

// Reads duration / size / fps / audio presence from `ffmpeg -i` (no ffprobe needed).
// Rotation metadata is applied so width/height are what the viewer actually sees.
const probeVideo = (file) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => {
        const dur = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const vid = err.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
        if (!dur || !vid) return reject(new Error('Could not read video info'));
        let width = +vid[1], height = +vid[2];
        const rot = err.match(/rotation of (-?\d+(?:\.\d+)?) degrees/);
        if (rot && Math.abs(Math.round(+rot[1])) % 180 === 90) [width, height] = [height, width];
        const fps = err.match(/,\s*(\d+(?:\.\d+)?)\s*fps/);
        resolve({
            seconds: (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]),
            width, height,
            fps: fps ? +fps[1] : 30,
            hasAudio: /Stream #\d+:\d+.*Audio:/.test(err)
        });
    });
});

// HD upscale that keeps the FILE SIZE about the same as the original.
// - upscales (lanczos + light sharpen) so the short side reaches targetShortSide (default 1080)
// - never downsizes: if the video is already >= target it is left alone (returns null)
// - two-pass x264 aimed at the original's size, so the output lands close to the input's MB
// opts: targetShortSide, audioKbps, preset, sharpen (0 = off), denoise (true/false), maxFps, twoPass, sizeTolerance
const enhanceVideo = async (buffer, opts = {}) => {
    const {
        targetShortSide = 1080, audioKbps = 128, preset = 'slow',
        sharpen = 0.6, denoise = true, maxFps = 60, twoPass = true, sizeTolerance = 1.08
    } = opts;
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-'));
    const input = path.join(dir, 'input.bin');
    const output = path.join(dir, 'output.mp4');
    try {
        await fs.promises.writeFile(input, buffer);
        const info = await probeVideo(input);

        const shortSide = Math.min(info.width, info.height);
        if (shortSide >= targetShortSide) return null; // already HD, re-encoding could only hurt

        const scale = targetShortSide / shortSide;
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        const outW = even(info.width * scale);
        const outH = even(info.height * scale);

        // total bitrate that reproduces the original file size (2% margin for container overhead)
        const totalKbps = (buffer.length * 8 * 0.98) / Math.max(info.seconds, 1) / 1000;
        const aKbps = info.hasAudio ? audioKbps : 0;
        const vKbps = Math.max(300, Math.floor(totalKbps - aKbps));

        const filters = [];
        if (info.fps > maxFps && maxFps > 0) filters.push(`fps=${maxFps}`);
        if (denoise) filters.push('hqdn3d=1.5:1.5:6:6'); // removes noise so bitrate goes to real detail
        filters.push(`scale=${outW}:${outH}:flags=lanczos`);
        if (sharpen > 0) filters.push(`unsharp=5:5:${sharpen}:5:5:0.0`);
        filters.push('format=yuv420p');

        const video = [
            '-map', '0:v:0',
            '-vf', filters.join(','),
            '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high',
            '-b:v', `${vKbps}k`, '-maxrate', `${Math.floor(vKbps * 1.5)}k`, '-bufsize', `${vKbps * 2}k`
        ];
        const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const logBase = path.join(dir, 'pass');

        if (twoPass) {
            await runFfmpeg(['-y', '-i', input, ...video, '-pass', '1', '-passlogfile', logBase, '-an', '-f', 'null', nullOut]);
        }
        const audio = info.hasAudio ? ['-map', '0:a?', '-c:a', 'aac', '-b:a', `${aKbps}k`] : ['-an'];
        await runFfmpeg([
            '-y', '-i', input, ...video,
            ...(twoPass ? ['-pass', '2', '-passlogfile', logBase] : []),
            ...audio, '-movflags', '+faststart', output
        ]);

        const out = await fs.promises.readFile(output);
        if (out.length > buffer.length * sizeTolerance) return null; // would grow the file, keep the original
        return { buffer: out, width: outW, height: outH, from: `${info.width}x${info.height}` };
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
    let sent;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            sent = await sock.sendMessage('status@broadcast', content, { statusJidList });
            break;
        } catch (e) {
            if (attempt === 2 || !/Request Timeout|Timed Out/i.test(e.message || '')) throw e;
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
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
    bind, add, getAudience, postStory, splitVideo, remuxVideo, compressVideo, enhanceVideo,
    audienceSize: () => audience.size,
    listPosted, deleteAllStories
};
