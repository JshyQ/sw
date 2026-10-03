const axios = require('axios');
const chalk = require('chalk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TT_LINK = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SECONDS_PER_IMAGE = 3.5;   // every image is shown for exactly this long
const TRANSITION = 0.4;        // seconds of the right-to-left slide between images
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 60;

const config = () => require('../settings/config');

// Terminal progress messages so you can see what the bot is doing.
const log = (msg, kind = 'info') => {
    const colors = { info: chalk.cyan, ok: chalk.green, warn: chalk.yellow, err: chalk.red };
    const time = new Date().toLocaleTimeString('en-GB');
    console.log(chalk.gray(`[${time}]`), colors[kind]('[ttslide]'), msg);
};
const secs = (start) => ((Date.now() - start) / 1000).toFixed(1) + 's';

const abs = (u) => (u && u.startsWith('http') ? u : u ? 'https://www.tikwm.com' + u : null);

const fetchInfo = async (url) => {
    const { data } = await axios.get('https://www.tikwm.com/api/', {
        params: { url, hd: 1 },
        headers: { 'User-Agent': UA },
        timeout: 20000
    });
    if (!data || data.code !== 0 || !data.data) {
        throw new Error(data?.msg || 'tikwm did not return a result for that link');
    }
    return data.data;
};

// Same lookup order the story code uses: config.story.ffmpegPath -> system ffmpeg -> bundled binary.
let ffmpegCache = null;
const ffmpegPath = () => {
    if (ffmpegCache) return ffmpegCache;
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

const runFfmpeg = (args) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0
        ? resolve(err)
        : reject(new Error(`ffmpeg exited with code ${code}: ` + err.trim().split('\n').slice(-4).join(' | ').slice(-400)))));
});

const download = async (url, file, maxMb) => {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/' },
        timeout: 60000,
        maxContentLength: maxMb * 1024 * 1024
    });
    fs.writeFileSync(file, Buffer.from(res.data));
};

// Builds the slideshow. Each image is on screen for SECONDS_PER_IMAGE seconds and the next one
// slides in from the right (like swiping in TikTok). Total length = images x SECONDS_PER_IMAGE.
const buildSlideshow = async (imageFiles, audioFile, outFile) => {
    const n = imageFiles.length;
    const total = n * SECONDS_PER_IMAGE;
    const args = ['-y', '-hide_banner'];

    // Every clip except the last runs TRANSITION seconds longer so the slide overlaps the next one.
    imageFiles.forEach((file, i) => {
        const len = i < n - 1 ? SECONDS_PER_IMAGE + TRANSITION : SECONDS_PER_IMAGE;
        args.push('-loop', '1', '-framerate', String(FPS), '-t', String(len), '-i', file);
    });
    if (audioFile) args.push('-stream_loop', '-1', '-i', audioFile); // loop if the music is shorter

    const filters = [];
    for (let i = 0; i < n; i++) {
        // blurred full-screen copy as background, sharp copy fitted on top (no stretching/cropping)
        filters.push(
            `[${i}:v]split=2[bg${i}][fg${i}];` +
            `[bg${i}]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=30:5[b${i}];` +
            `[fg${i}]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[f${i}];` +
            `[b${i}][f${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
        );
    }

    let last = 'v0';
    for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? 'vout' : `x${i}`;
        // transition i starts when image i-1 has been shown for SECONDS_PER_IMAGE seconds
        filters.push(`[${last}][v${i}]xfade=transition=slideleft:duration=${TRANSITION}:offset=${i * SECONDS_PER_IMAGE}[${out}]`);
        last = out;
    }
    if (n === 1) filters.push('[v0]null[vout]');

    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
    if (audioFile) {
        args.push('-map', `${n}:a`, '-af', `afade=t=out:st=${Math.max(total - 1, 0)}:d=1`, '-c:a', 'aac', '-b:a', '128k');
    }
    args.push(
        '-t', String(total),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outFile
    );
    log(`Turning ${n} image${n > 1 ? 's' : ''} into a ${total}s video (ffmpeg encoding, this is the slow part)...`);
    const start = Date.now();
    await runFfmpeg(args);
    log(`Video encoded in ${secs(start)}`, 'ok');
};

module.exports = {
    command: 'ttslide',
    description: 'Turn a TikTok photo post into a slideshow video (5s per image, music included)',
    category: 'downloader',
    execute: async (sock, m, { text, reply, prefix }) => {
        const link = (text.match(TT_LINK) || [])[0];
        if (!link) {
            return reply(`Send a TikTok photo post link.\nExample: ${prefix}ttslide https://vt.tiktok.com/xxxxxxx/`);
        }

        await sock.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });

        const t0 = Date.now();
        log(`New request: ${link}`);
        log('Fetching post info from tikwm...');

        let info;
        try {
            info = await fetchInfo(link);
            log('Post info received', 'ok');
        } catch (e) {
            log(`Could not fetch post info: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Couldn't fetch that TikTok: ${e.message}`);
        }

        const images = (info.images || []).map(abs).filter(Boolean);
        if (!images.length) {
            log('Post has no images (normal video), stopping', 'warn');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`That post has no images (it looks like a normal video). Use ${prefix}tt for videos.`);
        }

        const total = images.length * SECONDS_PER_IMAGE;
        await reply(`Photo post with ${images.length} image${images.length > 1 ? 's' : ''}. Building a ${total}s slideshow (${SECONDS_PER_IMAGE}s each)...`);

        log(`Found ${images.length} image${images.length > 1 ? 's' : ''}, ${total}s slideshow planned`);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttslide-'));
        try {
            const files = [];
            for (let i = 0; i < images.length; i++) {
                const f = path.join(dir, `img${String(i).padStart(3, '0')}.jpg`);
                log(`Downloading image ${i + 1}/${images.length}...`);
                await download(images[i], f, 30);
                files.push(f);
            }
            log('All images downloaded', 'ok');

            // Post music (optional: if it can't be fetched the video is still made, just silent)
            let audioFile = null;
            const musicUrl = abs(info.music) || abs(info.music_info?.play);
            if (musicUrl) {
                try {
                    log('Downloading post music...');
                    audioFile = path.join(dir, 'music.mp3');
                    await download(musicUrl, audioFile, 30);
                    log('Music downloaded', 'ok');
                } catch (e) {
                    audioFile = null;
                    log(`Music download failed (${e.message}), continuing without audio`, 'warn');
                }
            } else {
                log('No music found for this post, video will be silent', 'warn');
            }

            const outFile = path.join(dir, 'slideshow.mp4');
            await buildSlideshow(files, audioFile, outFile);

            const caption = info.title
                ? `${info.title}${info.author?.nickname ? `\n\n🎵 @${info.author.unique_id || info.author.nickname}` : ''}`
                : undefined;

            const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
            log(`Sending video to chat (${sizeMb} MB)...`);
            await sock.sendMessage(m.chat, {
                video: fs.readFileSync(outFile),
                mimetype: 'video/mp4',
                caption
            }, { quoted: m });

            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
            log(`Done! Total time ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`FAILED: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            await reply(`Couldn't build the slideshow: ${e.message}`);
        } finally {
            log('Cleaning up temp files');
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
