const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('play');
const config = () => require('../settings/config');

const MAX_MB = 48;              // refuse anything bigger than this
const DOC_ABOVE_MB = 14;        // above this, send as a document so WhatsApp doesn't mangle the tags
const MAX_DURATION = 900;       // refuse anything longer than 15 minutes
const MIN_DURATION = 30;        // skip clips shorter than this
const SEARCH_RESULTS = 8;
const TIMEOUT_MS = 240000;

const YT_URL = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/\S+/i;

// One job per chat at a time, so a second .play does not fight the first over a temp dir.
const busy = new Set();
const cache = { ytdlp: null, ffmpeg: null };

// ---------------------------------------------------------------------------
// Binary lookup. PATH is not trusted: processes started by pm2, systemd or screen
// usually inherit a stripped environment, so a login shell and the usual install
// locations are consulted instead, and the answer is cached once found.
// ---------------------------------------------------------------------------
const FULL_PATH = (() => {
    const extra = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin', '/opt/homebrew/bin'];
    const have = (process.env.PATH || '').split(':').filter(Boolean);
    return [...new Set([...extra, ...have])].join(':');
})();

const env = () => ({ ...process.env, PATH: FULL_PATH });

const probe = (bin) => {
    if (!bin || !fs.existsSync(bin)) return false;
    try {
        return spawnSync(bin, ['--version'], { stdio: 'ignore', env: env(), timeout: 8000 }).status === 0;
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

    const tried = [...new Set(candidates)];
    for (const bin of tried) if (probe(bin)) return { bin, tried };
    return { bin: null, tried };
};

const ytdlpPath = () => {
    if (cache.ytdlp) return cache.ytdlp;
    const extra = [config().music?.ytdlpPath];
    try { extra.push(require('yt-dlp-exec').path); } catch {}
    const { bin, tried } = locate(['yt-dlp', 'youtube-dl'], extra.filter(Boolean));
    if (!bin) throw new Error(`yt-dlp not found (tried: ${tried.join(', ') || 'nothing'})`);
    cache.ytdlp = bin;
    return bin;
};

const ffmpegPath = () => {
    if (cache.ffmpeg) return cache.ffmpeg;
    const extra = [
        config().story?.ffmpegPath,
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/snap/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg'
    ];
    try { extra.push(require('@ffmpeg-installer/ffmpeg').path); } catch {}
    const { bin } = locate(['ffmpeg'], extra.filter(Boolean));
    cache.ffmpeg = bin;
    return bin;
};

const run = (bin, args) => new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: env() });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        const last = stderr.trim().split('\n').pop() || 'no details';
        reject(new Error(last));
    });
});

// ---------------------------------------------------------------------------
// Matching. The top search hit for a music query is usually right, but not always,
// so a handful of results are scored on how much of the query the title actually
// contains, with a nudge for label channels and sane track lengths.
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const score = (entry, tokens) => {
    const title = norm(entry.title);
    if (!title) return -1000;

    const hits = tokens.filter((t) => title.includes(t)).length;
    let s = (hits / tokens.length) * 100;

    if (/topic|vevo|official/i.test(entry.uploader || '')) s += 15;
    if (tokens.every((t) => title.includes(t))) s += 20;

    const d = Number(entry.duration) || 0;
    if (d >= 90 && d <= 420) s += 10;
    if (d > MAX_DURATION) s -= 100;
    if (d && d < MIN_DURATION) s -= 50;

    if (/\b(full album|1 hour|hour mix|reaction|tutorial|instrumental)\b/i.test(title)) s -= 20;
    if (/\b(remix|cover|slowed|reverb|nightcore|8d)\b/i.test(title)) s -= 5;

    return s;
};

const search = async (query) => {
    const bin = ytdlpPath();
    const raw = await run(bin, [
        '--dump-single-json', '--flat-playlist', '--no-warnings', '--no-call-home',
        `ytsearch${SEARCH_RESULTS}:${query}`
    ]);

    let entries;
    try {
        entries = JSON.parse(raw).entries || [];
    } catch {
        throw new Error('the search returned something unreadable');
    }
    if (!entries.length) throw new Error('no results for that query');

    const tokens = norm(query).split(' ').filter((t) => t.length > 1);
    if (!tokens.length) throw new Error('the query is too short to search on');

    const ranked = entries.map((e) => ({ entry: e, s: score(e, tokens) })).sort((a, b) => b.s - a.s);

    if (!ranked[0] || ranked[0].s <= 0) throw new Error('nothing matched that query closely enough');
    return ranked[0].entry;
};

// ---------------------------------------------------------------------------
// Download. Audio only, straight to MP3 at the best quality the source offers,
// with the cover art and tags written in. Without ffmpeg the raw audio stream is
// kept instead, which still plays but carries no tags.
// ---------------------------------------------------------------------------
const MIMES = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.webm': 'audio/webm',
    '.opus': 'audio/ogg',
    '.ogg': 'audio/ogg'
};

const grabAudio = async (url, dir) => {
    const bin = ytdlpPath();
    const ff = ffmpegPath();

    const args = ['--no-playlist', '--no-warnings', '--no-call-home', '--geo-bypass'];

    if (ff) {
        args.push(
            '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
            '--embed-thumbnail', '--embed-metadata',
            '--ffmpeg-location', ff
        );
    } else {
        args.push('--format', 'bestaudio/best', '--no-part');
    }

    args.push('--output', path.join(dir, 'audio.%(ext)s'), url);

    await run(bin, args);

    const file = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
    if (!file) throw new Error('the download produced no file');

    const full = path.join(dir, file);
    return { file: full, mime: MIMES[path.extname(file).toLowerCase()] || 'audio/mpeg' };
};

const mmss = (total) => {
    const s = Number(total) || 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

module.exports = {
    command: 'play',
    description: 'Find a song on YouTube and send it as an MP3',
    category: 'downloader',
    execute: async (sock, m, { text, reply, prefix }) => {
        const input = (text || '').trim();
        if (!input) {
            return reply(`Send a song name.\nExample: ${prefix}play ed sheeran shape of you`);
        }
        if (busy.has(m.chat)) {
            return reply('Already working on something in this chat, give it a moment.');
        }

        busy.add(m.chat);
        const t0 = Date.now();
        let dir;

        try {
            const direct = (input.match(YT_URL) || [])[0];
            await sock.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

            let target;
            let title;
            let artist;
            let duration;

            if (direct) {
                log(`Direct link: ${direct}`);
                target = direct;
            } else {
                log(`Searching: ${input}`);
                const hit = await search(input);
                if (hit.duration && Number(hit.duration) > MAX_DURATION) {
                    throw new Error(`the best match is ${mmss(hit.duration)} long, over the ${mmss(MAX_DURATION)} limit`);
                }
                target = `https://www.youtube.com/watch?v=${hit.id}`;
                title = hit.title;
                artist = hit.uploader;
                duration = hit.duration;
                log(`Matched: ${title} (${mmss(duration)}) by ${artist}`, 'ok');
            }

            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
            log('Downloading audio...');
            const { file, mime } = await grabAudio(target, dir);

            const buffer = fs.readFileSync(file);
            const mb = buffer.length / 1024 / 1024;
            log(`Downloaded: ${mb.toFixed(2)} MB in ${secs(t0)}`, 'ok');

            if (mb > MAX_MB) {
                throw new Error(`the file is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB limit`);
            }

            const heading = [title, artist].filter(Boolean).join('\n');
            const caption = [heading, duration ? mmss(duration) : null].filter(Boolean).join(' • ') || undefined;
            const asDocument = mb > DOC_ABOVE_MB || mime !== 'audio/mpeg';

            log(`Sending to chat as ${asDocument ? 'document' : 'audio'}...`);
            if (asDocument) {
                const ext = path.extname(file) || '.mp3';
                await sock.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: mime,
                    fileName: `${(title || 'audio').replace(/[\\/:*?"<>|]/g, '').slice(0, 80)}${ext}`,
                    caption
                }, { quoted: m });
            } else {
                await sock.sendMessage(m.chat, {
                    audio: buffer,
                    mimetype: mime,
                    ptt: false,
                    caption
                }, { quoted: m });
            }

            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
            log(`Done! Total time ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`Failed: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            await reply(`Couldn't get that song: ${e.message}`);
        } finally {
            busy.delete(m.chat);
            if (dir) fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
