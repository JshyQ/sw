const yts = require('yt-search');
const axios = require('axios');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLog } = require('../library/botlog');
const log = makeLog('play');
const config = () => require('../settings/config');

const WORKER = 'https://yt-dl.officialhectormanuel.workers.dev/?url=';
const MAX_MB = 48;
const DOC_ABOVE_MB = 14;
const MAX_DURATION = 900;
const MIN_DURATION = 20;
const TIMEOUT_MS = 300000;

const YT_URL = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/\S+/i;
const AUDIO_EXT = ['.mp3', '.m4a', '.opus', '.webm', '.ogg'];

const busy = new Set();
const cache = { ytdlp: null, ffmpeg: null, ytmdl: undefined };

// ---------------------------------------------------------------------------
// Binary lookup. PATH is not trusted: pm2/systemd/screen hand the process a
// stripped environment, so a login shell and the usual install locations are
// consulted instead, and the answer is cached once found.
// ---------------------------------------------------------------------------
const FULL_PATH = (() => {
    const extra = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin', '/opt/homebrew/bin'];
    const have = (process.env.PATH || '').split(':').filter(Boolean);
    return [...new Set([...extra, ...have])].join(':');
})();

const env = () => ({ ...process.env, PATH: FULL_PATH });

const probe = (bin, args = ['--version']) => {
    if (!bin || !fs.existsSync(bin)) return false;
    try {
        return spawnSync(bin, args, { stdio: 'ignore', env: env(), timeout: 15000 }).status === 0;
    } catch {
        return false;
    }
};

const locate = (names, extra = []) => {
    const candidates = [];
    for (const name of names) {
        try {
            const r = spawnSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', env: env(), timeout: 8000 });
            for (const line of String(r.stdout || '').split('\n')) {
                const p = line.trim();
                if (p.startsWith('/') && fs.existsSync(p)) candidates.push(p);
            }
        } catch {}
    }
    for (const p of extra) if (p) candidates.push(p);
    for (const bin of [...new Set(candidates)]) if (probe(bin)) return bin;
    return null;
};

const ytdlpPath = () => {
    if (cache.ytdlp) return cache.ytdlp;
    const extra = [config().music?.ytdlpPath];
    try { extra.push(require('yt-dlp-exec').path); } catch {}
    cache.ytdlp = locate(['yt-dlp', 'youtube-dl'], extra.filter(Boolean));
    return cache.ytdlp;
};

const ffmpegPath = () => {
    if (cache.ffmpeg) return cache.ffmpeg;
    const extra = [
        config().story?.ffmpegPath,
        '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'
    ];
    try { extra.push(require('@ffmpeg-installer/ffmpeg').path); } catch {}
    cache.ffmpeg = locate(['ffmpeg'], extra.filter(Boolean));
    return cache.ffmpeg;
};

// ytmdl is a Python console script; fall back to `python3 -m ytmdl` if the
// script is not on PATH but the module is installed.
const ytmdlCmd = () => {
    if (cache.ytmdl !== undefined) return cache.ytmdl;

    const bin = locate(['ytmdl'], [config().music?.ytmdlPath].filter(Boolean));
    if (bin) {
        cache.ytmdl = { bin, pre: [] };
        return cache.ytmdl;
    }

    for (const py of ['python3', 'python']) {
        if (probe(py, ['-c', 'import ytmdl'])) {
            cache.ytmdl = { bin: py, pre: ['-m', 'ytmdl'] };
            return cache.ytmdl;
        }
    }

    cache.ytmdl = null;
    return null;
};

const run = (bin, args, timeout = TIMEOUT_MS) => new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: env() });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        reject(new Error(stderr.trim().split('\n').pop() || 'no details'));
    });
});

// ---------------------------------------------------------------------------
// Matching. Scored so a remix, cover or hour-long mix does not win by accident.
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const score = (video, tokens) => {
    const title = norm(video.title);
    if (!title) return -1000;

    const hits = tokens.filter((t) => title.includes(t)).length;
    let s = (hits / tokens.length) * 100;
    if (tokens.every((t) => title.includes(t))) s += 25;

    const d = Number(video.seconds) || 0;
    if (d >= 90 && d <= 420) s += 10;
    if (d > MAX_DURATION) s -= 100;
    if (d && d < MIN_DURATION) s -= 50;

    if (/topic|vevo|official/i.test(video.author?.name || '')) s += 15;
    if (/\b(full album|1 hour|hour mix|reaction|tutorial)\b/i.test(title)) s -= 20;
    if (/\b(remix|cover|slowed|reverb|nightcore|karaoke|instrumental)\b/i.test(title)) s -= 8;

    return s;
};

const mmss = (total) => {
    const s = Number(total) || 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const newestAudio = (dir) => {
    const files = fs.readdirSync(dir)
        .filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()))
        .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    return files[0] ? path.join(dir, files[0].f) : null;
};

// ---------------------------------------------------------------------------
// Sources, in order: ytmdl (tags and cover included), yt-dlp, then the worker.
// ---------------------------------------------------------------------------
const grabWithYtmdl = async (url, dir) => {
    const cmd = ytmdlCmd();
    if (!cmd) throw new Error('ytmdl not installed');

    const args = [...cmd.pre, '--quiet', '--url', url, '--output-dir', dir];
    try {
        await run(cmd.bin, args);
    } catch (e) {
        // Older builds may not know --output-dir; retry without it and scan.
        if (!/unrecognized|no such option|invalid/i.test(e.message)) throw e;
        await run(cmd.bin, [...cmd.pre, '--quiet', '--url', url]);
    }

    const file = newestAudio(dir);
    if (!file) throw new Error('ytmdl produced no file');
    return { file, tagged: true };
};

const grabWithYtdlp = async (url, dir) => {
    const bin = ytdlpPath();
    if (!bin) throw new Error('yt-dlp not available');

    await run(bin, [
        '--no-playlist', '--no-warnings', '--no-call-home', '--geo-bypass',
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
        '--output', path.join(dir, 'audio.%(ext)s'),
        url
    ]);

    const file = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
    if (!file) throw new Error('yt-dlp produced no file');
    return { file: path.join(dir, file), tagged: false };
};

const grabWithWorker = async (url, dir) => {
    const { data } = await axios.get(`${WORKER}${encodeURIComponent(url)}`, { timeout: 60000 });
    if (!data?.status || !data.audio) throw new Error('the worker returned no audio');

    const res = await axios.get(data.audio, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: MAX_MB * 1024 * 1024
    });

    const file = path.join(dir, 'audio.mp3');
    fs.writeFileSync(file, Buffer.from(res.data));
    return { file, tagged: false };
};

// Adds thumbnail art and tags to sources that do not supply their own.
const tagFile = async (input, video, dir) => {
    const ff = ffmpegPath();
    if (!ff || !video.thumbnail) return input;

    try {
        const cover = path.join(dir, 'cover.jpg');
        const res = await axios.get(video.thumbnail, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxContentLength: 6 * 1024 * 1024
        });
        fs.writeFileSync(cover, Buffer.from(res.data));

        const out = path.join(dir, 'tagged.mp3');
        await run(ff, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', input, '-i', cover,
            '-map', '0:a', '-map', '1:v',
            '-c:a', 'copy', '-c:v', 'mjpeg', '-id3v2_version', '3',
            '-metadata', `title=${video.title}`,
            '-metadata', `artist=${video.author?.name || 'YouTube'}`,
            '-metadata:s:v', 'title=Album cover',
            '-metadata:s:v', 'comment=Cover (front)',
            out
        ]);
        return out;
    } catch {
        return input;
    }
};

module.exports = {
    command: 'play',
    description: 'Download high quality audio from YouTube',
    category: 'downloader',
    execute: async (sock, m, { text, prefix, reply }) => {
        if (!text) {
            return reply(`🎵 *Music Downloader*\n\n❌ Please provide a song name!\n📝 Example: ${prefix}play Lilly Alan Walker\n\n⚡ Powered by Queen Riam`);
        }
        if (busy.has(m.chat)) {
            return reply('⏳ Already fetching something in this chat, give it a moment.');
        }

        busy.add(m.chat);
        const t0 = Date.now();
        let dir;

        try {
            await sock.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

            let video;
            const direct = (text.match(YT_URL) || [])[0];

            if (direct) {
                video = { url: direct, title: direct, thumbnail: null, seconds: 0, author: {} };
            } else {
                const { videos } = await yts(text);
                if (!videos?.length) {
                    await sock.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });
                    return reply('🔍 *Search Results*\n\n⚠️ No songs found for your search query!\n💡 Try different keywords');
                }

                const tokens = norm(text).split(' ').filter((t) => t.length > 1);
                if (!tokens.length) return reply('❌ That query is too short to search on.');

                const ranked = videos.map((v) => ({ v, s: score(v, tokens) })).sort((a, b) => b.s - a.s);
                if (!ranked[0] || ranked[0].s <= 0) {
                    await sock.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });
                    return reply('🔍 *Search Results*\n\n⚠️ Nothing matched that closely!\n💡 Try artist and title together');
                }

                video = ranked[0].v;
            }

            if (Number(video.seconds) > MAX_DURATION) {
                await sock.sendMessage(m.chat, { react: { text: '⏱️', key: m.key } });
                return reply(`⏱️ *Too Long*\n\nThat one runs ${mmss(video.seconds)}, over the ${mmss(MAX_DURATION)} limit.\n💡 Try a single track instead`);
            }

            await sock.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });

            if (video.thumbnail) {
                await sock.sendMessage(m.chat, {
                    image: { url: video.thumbnail },
                    caption: `🎵 *Track Details*\n\n📀 Title: ${video.title}\n⏱️ Duration: ${video.timestamp || mmss(video.seconds)}\n👁️ Views: ${video.views || 'n/a'}\n📅 Uploaded: ${video.ago || 'n/a'}\n\n⬇️ Starting download...\n\n🎶 Powered by Queen Riam`
                }, { quoted: m });
            }

            await sock.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });

            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));

            let got;
            const sources = [grabWithYtmdl, grabWithYtdlp, grabWithWorker];
            let lastError;
            for (const source of sources) {
                try {
                    got = await source(video.url, dir);
                    break;
                } catch (e) {
                    lastError = e;
                    log(`${source.name} failed: ${e.message}`, 'warn');
                }
            }
            if (!got) throw lastError || new Error('every source failed');

            const file = got.tagged ? got.file : await tagFile(got.file, video, dir);

            const buffer = fs.readFileSync(file);
            const mb = buffer.length / 1024 / 1024;

            if (mb > MAX_MB) {
                await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
                return reply(`🚫 *Too Large*\n\nThe file is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB limit.`);
            }

            await sock.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });

            const safe = `${video.title}`.replace(/[<>:"/\\|?*]/g, '').slice(0, 80);
            const card = {
                externalAdReply: {
                    title: '🎵 Download Complete!',
                    body: `Click to play ${video.title}`,
                    mediaType: 2,
                    thumbnailUrl: video.thumbnail,
                    sourceUrl: video.url
                }
            };

            if (mb > DOC_ABOVE_MB) {
                await sock.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: 'audio/mpeg',
                    fileName: `${safe}.mp3`,
                    contextInfo: card
                }, { quoted: m });
            } else {
                await sock.sendMessage(m.chat, {
                    audio: buffer,
                    mimetype: 'audio/mpeg',
                    ptt: false,
                    contextInfo: card
                }, { quoted: m });
            }

            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
            log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s via ${got.tagged ? 'ytmdl' : 'fallback'}`, 'ok');
        } catch (error) {
            console.error('Error in play command:', error);
            await sock.sendMessage(m.chat, { react: { text: '💥', key: m.key } });
            await reply(`💥 *Error Occurred*\n\n❌ ${error.message}\n🔧 Please try again later`);
        } finally {
            busy.delete(m.chat);
            if (dir) fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
