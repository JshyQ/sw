const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('spotify');
const config = () => require('../settings/config');

// Zapi credentials. Both can be overridden in settings/config under `music`.
const DEFAULT_KEY = 'zpi_yahb898cjndh3srjm8e0qcndoy';
const DEFAULT_BASE = 'https://api.zpi.web.id';

const MAX_MB = 48;
const DOC_ABOVE_MB = 14;
const MAX_DURATION = 900;
const MIN_DURATION = 20;
const TIMEOUT_MS = 240000;
const SEARCH_CACHE_MS = 300000;

const SPOTIFY_URL = /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z-]+\/)?track\/[A-Za-z0-9]+/i;
const SPOTIFY_URI = /spotify:track:([A-Za-z0-9]{22})/;
const TRACK_ID = /track[/:]([A-Za-z0-9]{22})/;

const busy = new Set();
const cache = { ytdlp: null, ffmpeg: null };
const searches = new Map();

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
// Zapi calls. The free tier is 600 requests a month, so search results are held
// for five minutes and the whole catalogue call is skipped on a cache hit.
// ---------------------------------------------------------------------------
const api = () => ({
    base: (config().music?.zapiBase || DEFAULT_BASE).replace(/\/+$/, ''),
    key: config().music?.zapiKey || process.env.ZAPI_KEY || DEFAULT_KEY
});

const get = async (route, params = {}) => {
    const { base, key } = api();
    const res = await axios.get(`${base}${route}`, {
        params,
        headers: { 'x-api-key': key, Accept: 'application/json' },
        timeout: 25000,
        validateStatus: () => true
    });

    if (res.status === 401) throw new Error('the Spotify API key was rejected');
    if (res.status === 429) throw new Error('the Spotify API quota is used up for now');
    if (res.status === 404) throw new Error('Spotify has no such track');
    if (res.status >= 400) throw new Error(`the Spotify API answered ${res.status}`);

    return res.data?.data ?? res.data;
};

// ---------------------------------------------------------------------------
// Matching. Spotify's own relevance is decent, but the query still has to be
// scored against the title and artist so a remix or a karaoke version does not
// win by accident.
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const scoreTrack = (track, tokens) => {
    const hay = norm(`${track.title} ${track.artist}`);
    if (!hay) return -1000;

    const hits = tokens.filter((t) => hay.includes(t)).length;
    let s = (hits / tokens.length) * 100;
    if (tokens.every((t) => hay.includes(t))) s += 25;

    const d = (Number(track.durationMs) || 0) / 1000;
    if (d >= 90 && d <= 420) s += 10;
    if (d > MAX_DURATION) s -= 100;
    if (d && d < MIN_DURATION) s -= 50;

    if (/\b(remix|cover|karaoke|instrumental|sped up|slowed)\b/i.test(track.title)) s -= 12;
    if (track.playable === false) s -= 40;

    return s;
};

const searchSpotify = async (query) => {
    const key = norm(query);
    const held = searches.get(key);
    if (held && Date.now() - held.at < SEARCH_CACHE_MS) return held.data;

    const data = await get('/v1/music:spotify/search', { q: query, type: 'track', page: 1 });
    const items = (data?.items || []).filter((t) => t?.trackId);

    const tokens = key.split(' ').filter((t) => t.length > 1);
    if (!tokens.length) throw new Error('the query is too short to search on');
    if (!items.length) throw new Error('Spotify found nothing for that query');

    const ranked = items.map((t) => ({ track: t, s: scoreTrack(t, tokens) })).sort((a, b) => b.s - a.s);
    if (!ranked[0] || ranked[0].s <= 0) throw new Error('nothing on Spotify matched that query closely enough');

    const best = ranked[0].track;
    const result = {
        title: best.title,
        artist: best.artist,
        album: best.album || null,
        image: best.image || null,
        url: best.url,
        duration: Math.round((Number(best.durationMs) || 0) / 1000) || 0
    };

    searches.set(key, { at: Date.now(), data: result });
    if (searches.size > 100) searches.delete(searches.keys().next().value);
    return result;
};

const trackById = async (id) => {
    const data = await get(`/v1/music:spotify/track/${id}`);
    if (!data?.title) throw new Error('Spotify has no such track');
    return {
        title: data.title,
        artist: data.artists?.map((a) => a.name).join(', ') || data.artist || '',
        album: data.album || null,
        image: data.image || null,
        url: data.url,
        duration: Math.round((Number(data.durationMs) || 0) / 1000) || 0,
        preview: data.preview || null
    };
};

// ---------------------------------------------------------------------------
// Full audio. Spotify only serves 30 second previews, so the real file comes from
// YouTube, found by "artist title" and scored against the Spotify duration.
// ---------------------------------------------------------------------------
const pickYouTube = (entries, track) => {
    const tokens = norm(`${track.artist} ${track.title}`).split(' ').filter((t) => t.length > 1);

    const scored = entries.map((e) => {
        const title = norm(e.title);
        let s = 0;
        if (title) {
            const hits = tokens.filter((t) => title.includes(t)).length;
            s = (hits / Math.max(tokens.length, 1)) * 100;
            if (/topic|vevo|official/i.test(e.uploader || '')) s += 12;
        }
        const d = Number(e.duration) || 0;
        if (track.duration && d) {
            const delta = Math.abs(d - track.duration);
            if (delta <= 5) s += 40;
            else if (delta <= 20) s += 15;
            else if (delta > 60) s -= 25;
        }
        if (/\b(live|cover|karaoke|instrumental|remix)\b/i.test(title)) s -= 8;
        return { e, s };
    });

    scored.sort((a, b) => b.s - a.s);
    return scored[0]?.e || null;
};

const grabAudio = async (track, dir) => {
    const bin = ytdlpPath();
    const query = `${track.artist} ${track.title}`.trim();

    const raw = await run(bin, [
        '--dump-single-json', '--flat-playlist', '--no-warnings', '--no-call-home',
        `ytsearch5:${query}`
    ]);

    let entries = [];
    try { entries = JSON.parse(raw).entries || []; } catch {}
    if (!entries.length) throw new Error('no audio source found on YouTube');

    const hit = pickYouTube(entries, track);
    if (!hit?.id) throw new Error('no usable audio source found on YouTube');

    const file = path.join(dir, 'audio.%(ext)s');
    await run(bin, [
        '--no-playlist', '--no-warnings', '--no-call-home', '--geo-bypass',
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
        '--output', file,
        `https://www.youtube.com/watch?v=${hit.id}`
    ]);

    const produced = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
    if (!produced) throw new Error('the download produced no file');
    return path.join(dir, produced);
};

// Writes the Spotify artwork and tags into the file, so the delivered MP3 carries
// the cover rather than whatever the YouTube upload happened to have.
const tagFile = async (input, track, dir) => {
    const ff = ffmpegPath();
    if (!ff || !track.image) return input;

    try {
        const cover = path.join(dir, 'cover.jpg');
        const res = await axios.get(track.image, {
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
            '-metadata', `title=${track.title}`,
            '-metadata', `artist=${track.artist}`,
            ...(track.album ? ['-metadata', `album=${track.album}`] : []),
            '-metadata:s:v', 'title=Album cover',
            '-metadata:s:v', 'comment=Cover (front)',
            out
        ]);
        return out;
    } catch (e) {
        log(`Tagging skipped: ${e.message}`, 'warn');
        return input;
    }
};

const mmss = (total) => {
    const s = Number(total) || 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

module.exports = {
    command: 'spotify',
    description: 'Find a song on Spotify and send it as an MP3',
    category: 'downloader',
    execute: async (sock, m, { text, reply, prefix }) => {
        const input = (text || '').trim();
        if (!input) {
            return reply(`Send a song name or Spotify link.\nExample: ${prefix}spotify ed sheeran shape of you`);
        }
        if (busy.has(m.chat)) {
            return reply('Already working on something in this chat, give it a moment.');
        }

        busy.add(m.chat);
        const t0 = Date.now();
        let dir;

        try {
            const link = (input.match(SPOTIFY_URL) || [])[0];
            const id = link ? (link.match(TRACK_ID) || [])[1] : (input.match(SPOTIFY_URI) || [])[1];

            await sock.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

            let track;
            if (id) {
                log(`Track id: ${id}`);
                track = await trackById(id);
            } else {
                log(`Searching: ${input}`);
                track = await searchSpotify(input);
            }
            log(`Matched: ${track.title} by ${track.artist} (${mmss(track.duration)})`, 'ok');

            if (track.duration > MAX_DURATION) {
                throw new Error(`that track is ${mmss(track.duration)} long, over the ${mmss(MAX_DURATION)} limit`);
            }

            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-'));
            log('Downloading audio...');

            let file;
            let note;
            try {
                file = await grabAudio(track, dir);
            } catch (e) {
                if (!track.preview) throw e;
                log(`Full download failed (${e.message}), using the 30s preview`, 'warn');
                const res = await axios.get(track.preview, { responseType: 'arraybuffer', timeout: 20000 });
                file = path.join(dir, 'preview.mp3');
                fs.writeFileSync(file, Buffer.from(res.data));
                note = '30s preview';
            }

            file = await tagFile(file, track, dir);

            const buffer = fs.readFileSync(file);
            const mb = buffer.length / 1024 / 1024;
            log(`Ready: ${mb.toFixed(2)} MB in ${secs(t0)}`, 'ok');

            if (mb > MAX_MB) throw new Error(`the file is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB limit`);

            const heading = `${track.title}\n${track.artist}`;
            const caption = [heading, [track.album, note].filter(Boolean).join(' • ')].filter(Boolean).join('\n');

            const fileName = `${`${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|]/g, '').slice(0, 80)}.mp3`;

            log(`Sending as ${mb > DOC_ABOVE_MB ? 'document' : 'audio'}...`);
            if (mb > DOC_ABOVE_MB) {
                await sock.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: 'audio/mpeg',
                    fileName,
                    caption
                }, { quoted: m });
            } else {
                await sock.sendMessage(m.chat, {
                    audio: buffer,
                    mimetype: 'audio/mpeg',
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
