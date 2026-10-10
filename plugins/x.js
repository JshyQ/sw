const axios = require('axios');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('x');
const config = () => require('../settings/config');

// Matches x.com / twitter.com (+ mobile., www.) and the fxtwitter / vxtwitter mirrors.
const X_LINK = /https?:\/\/(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)\/[^\s]+/i;
const STATUS_ID = /\/status(?:es)?\/(\d+)/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const MAX_MB = 100;        // refuse anything bigger than this
const DOC_ABOVE_MB = 60;   // above this, send as a document so WhatsApp doesn't choke on it

// Quality rule: the highest resolution X offers, never above 720p, at about the same
// file size as the earlier 480p downloads (roughly 840 kbps in total, audio included).
const MAX_SHORT_SIDE = 720;        // the shorter side of the picture is capped at 720 pixels
const ORIGINAL_MAX_BPS = 900000;   // a 720p-or-smaller original at or below this bitrate is sent unchanged
const VIDEO_KBPS = 700;            // target video bitrate when the file is re-encoded
const VIDEO_MAX_KBPS = 776;        // peak video bitrate, so the file cannot grow past the target
const AUDIO_KBPS = 64;

// ---------------------------------------------------------------------------
// Source: api.fxtwitter.com. Plain JSON that lists the tweet's video files, each with
// its address, resolution and bitrate. No website form is involved.
// ---------------------------------------------------------------------------
const videoFiles = (tweet) => {
    const files = [];
    const add = (src, width, height, bitrate) => {
        const short = width && height ? Math.min(width, height) : (height || width || 0);
        files.push({ url: src.url, width: width || 0, height: height || 0, short, bitrate: bitrate || 0 });
    };
    for (const v of tweet.media?.videos || []) {
        if (Array.isArray(v.variants) && v.variants.length) {
            for (const variant of v.variants) {
                if (!variant.url || !/mp4/i.test(variant.content_type || variant.url)) continue;
                add(variant, variant.width || v.width, variant.height || v.height, variant.bitrate);
            }
        } else if (v.url) {
            add(v, v.width, v.height, v.bitrate);
        }
    }
    return files;
};

const fetchFromFx = async (tweetUrl) => {
    const id = (tweetUrl.match(STATUS_ID) || [])[1];
    if (!id) throw new Error('could not find a tweet id in that link');
    const { data } = await axios.get(`https://api.fxtwitter.com/i/status/${id}`, {
        headers: { 'User-Agent': UA },
        timeout: 20000
    });
    const tweet = data?.tweet;
    if (!tweet) throw new Error(data?.message || 'tweet not found');
    const files = videoFiles(tweet);
    if (!files.length) throw new Error('that tweet has no video');
    // Best first: the highest resolution, then the highest bitrate.
    files.sort((a, b) => (b.short - a.short) || (b.bitrate - a.bitrate));
    const best = files[0];
    const who = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '';
    const caption = [tweet.text, who].filter(Boolean).join('\n\n') || null;
    // Send the file unchanged when it is already small; re-encode anything bigger or sharper.
    const keepOriginal = best.short > 0 && best.short <= MAX_SHORT_SIDE
        && (best.bitrate ? best.bitrate <= ORIGINAL_MAX_BPS : best.short <= 360);
    return {
        url: best.url,
        width: best.width,
        height: best.height,
        quality: best.short ? `${best.short}p` : null,
        caption,
        keepOriginal,
        source: 'fxtwitter'
    };
};

// ---------------------------------------------------------------------------
// Re-encoding with ffmpeg. The bot looks for ffmpeg in the same order as its other
// plugins: config.story.ffmpegPath, then the system ffmpeg, then the bundled binary.
// ---------------------------------------------------------------------------
const ffmpegPath = () => {
    const candidates = [config().story?.ffmpegPath, 'ffmpeg'].filter(Boolean);
    try { candidates.push(require('@ffmpeg-installer/ffmpeg').path); } catch {}
    for (const bin of candidates) {
        try {
            if (spawnSync(bin, ['-version']).status === 0) return bin;
        } catch {}
    }
    throw new Error('ffmpeg was not found on the server');
};

// Keeps the picture at its size but never above 720p. H.264 needs even sizes.
const scaleFilter = (width, height) => {
    if (width && height && Math.min(width, height) > MAX_SHORT_SIDE) {
        return width >= height ? 'scale=-2:720' : 'scale=720:-2';
    }
    return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
};

const runFfmpeg = (bin, args) => new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const last = stderr.trim().split('\n').pop() || 'no details';
        reject(new Error(`ffmpeg exited with code ${code}: ${last}`));
    });
});

const reencode = async (input, info) => {
    const bin = ffmpegPath();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-video-'));
    try {
        const inFile = path.join(dir, 'in.mp4');
        const outFile = path.join(dir, 'out.mp4');
        fs.writeFileSync(inFile, input);
        await runFfmpeg(bin, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', inFile,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', scaleFilter(info.width, info.height),
            '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
            '-b:v', `${VIDEO_KBPS}k`, '-maxrate', `${VIDEO_MAX_KBPS}k`, '-bufsize', `${VIDEO_MAX_KBPS * 2}k`,
            '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
            '-movflags', '+faststart',
            outFile
        ]);
        return fs.readFileSync(outFile);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

module.exports = {
    command: 'x',
    description: 'Download an X (Twitter) video in HD (up to 720p) at about the same file size',
    category: 'downloader',
    execute: async (sock, m, { text, reply, prefix }) => {
        const link = ((text || '').match(X_LINK) || [])[0];
        if (!link) {
            return reply(`Send an X (Twitter) video link.\nExample: ${prefix}x https://x.com/user/status/1234567890`);
        }
        if (!STATUS_ID.test(link)) {
            return reply('That link does not point to a specific post. Open the tweet and copy its link.');
        }

        await sock.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });

        const t0 = Date.now();
        log(`New request: ${link}`);

        let info;
        try {
            log('Trying fxtwitter...');
            info = await fetchFromFx(link);
            log(`Got video link from fxtwitter${info.quality ? ` (${info.quality})` : ''}`, 'ok');
        } catch (e) {
            log(`fxtwitter failed: ${e.message}`, 'warn');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Couldn't get a video from that link.\n• fxtwitter: ${e.message}`);
        }

        let buffer;
        log('Downloading video...');
        try {
            const res = await axios.get(info.url, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': UA, Referer: 'https://x.com/' },
                timeout: 90000,
                maxContentLength: MAX_MB * 1024 * 1024
            });
            buffer = Buffer.from(res.data);
            log(`Video downloaded: ${(buffer.length / 1024 / 1024).toFixed(2)} MB in ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`Download failed: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Download failed: ${e.message}`);
        }

        if (!info.keepOriginal) {
            log(`Re-encoding to 720p max, about ${VIDEO_KBPS + AUDIO_KBPS} kbps (file was ${(buffer.length / 1024 / 1024).toFixed(2)} MB)...`);
            try {
                buffer = await reencode(buffer, info);
                log(`Re-encoded: ${(buffer.length / 1024 / 1024).toFixed(2)} MB in ${secs(t0)}`, 'ok');
            } catch (e) {
                log(`Re-encode failed: ${e.message}`, 'err');
                await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
                return reply(`Couldn't process that video: ${e.message}`);
            }
        }

        const mb = buffer.length / 1024 / 1024;
        const caption = info.caption ? info.caption.slice(0, 900) : undefined;

        log('Sending to chat...');
        if (mb > DOC_ABOVE_MB) {
            await sock.sendMessage(m.chat, {
                document: buffer,
                mimetype: 'video/mp4',
                fileName: `x-video-${Date.now()}.mp4`,
                caption
            }, { quoted: m });
        } else {
            await sock.sendMessage(m.chat, {
                video: buffer,
                mimetype: 'video/mp4',
                caption
            }, { quoted: m });
        }

        await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        log(`Done! Total time ${secs(t0)}`, 'ok');
    }
};
