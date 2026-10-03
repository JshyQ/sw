const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TT_LINK = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SECONDS_PER_IMAGE = 5;   // every image is shown for exactly this long
const TRANSITION = 0.4;        // seconds of the right-to-left slide between images
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

const config = () => require('../settings/config');

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
    await runFfmpeg(args);
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

        let info;
        try {
            info = await fetchInfo(link);
        } catch (e) {
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Couldn't fetch that TikTok: ${e.message}`);
        }

        const images = (info.images || []).map(abs).filter(Boolean);
        if (!images.length) {
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`That post has no images (it looks like a normal video). Use ${prefix}tt for videos.`);
        }

        const total = images.length * SECONDS_PER_IMAGE;
        await reply(`Photo post with ${images.length} image${images.length > 1 ? 's' : ''}. Building a ${total}s slideshow (${SECONDS_PER_IMAGE}s each)...`);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttslide-'));
        try {
            const files = [];
            for (let i = 0; i < images.length; i++) {
                const f = path.join(dir, `img${String(i).padStart(3, '0')}.jpg`);
                await download(images[i], f, 30);
                files.push(f);
            }

            // Post music (optional: if it can't be fetched the video is still made, just silent)
            let audioFile = null;
            const musicUrl = abs(info.music) || abs(info.music_info?.play);
            if (musicUrl) {
                try {
                    audioFile = path.join(dir, 'music.mp3');
                    await download(musicUrl, audioFile, 30);
                } catch {
                    audioFile = null;
                }
            }

            const outFile = path.join(dir, 'slideshow.mp4');
            await buildSlideshow(files, audioFile, outFile);

            const caption = info.title
                ? `${info.title}${info.author?.nickname ? `\n\n🎵 @${info.author.unique_id || info.author.nickname}` : ''}`
                : undefined;

            await sock.sendMessage(m.chat, {
                video: fs.readFileSync(outFile),
                mimetype: 'video/mp4',
                caption
            }, { quoted: m });

            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        } catch (e) {
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            await reply(`Couldn't build the slideshow: ${e.message}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
