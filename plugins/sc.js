// .sc = turn an image into a sticker with a speech bubble on top of it.
//
//   Send a photo with the caption .sc        -> sticker with the bubble above the picture
//   Reply to a photo (or sticker) with .sc   -> same
//   .sc crop                                 -> picture fills its whole area (center-cropped)
//                                               instead of fitting inside it
//
// The bubble is library/assets/bubble.png (512 px wide, transparent background).
// Replace that file to change the bubble; the layout adapts to its height automatically.
// GIFs / short videos work too (animated sticker, first 10 seconds).
//
// Pack name / author come from config.sticker (settings/config.js), same as .s

const FileType = require('file-type');
const webp = require('node-webpmux');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeLog, secs } = require('../library/botlog');
const { isAnimatedWebp } = require('../library/cloudconvert');
const log = makeLog('sc');

const BUBBLE = path.join(__dirname, '..', 'library', 'assets', 'bubble.png');
const SIZE = 512;             // stickers are 512x512
const OVERLAP = 14;           // how far the bubble's tail dips into the picture (px)
const MAX_INPUT_MB = 50;
const MAX_SECONDS = 10;
const STATIC_MAX_KB = 100;    // WhatsApp limits
const ANIMATED_MAX_KB = 500;

const STATIC_STEPS = [{ q: 80 }, { q: 65 }, { q: 50 }, { q: 35 }, { q: 20 }];
const ANIMATED_STEPS = [
    { q: 55, fps: 15 }, { q: 40, fps: 15 }, { q: 30, fps: 12 }, { q: 20, fps: 10 }, { q: 10, fps: 8 }
];

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const config = () => require('../settings/config');

// ---- ffmpeg lookup: config.story.ffmpegPath -> system ffmpeg -> bundled binary
let ffmpegCache = null;
const ffmpegPath = () => {
    if (ffmpegCache) return ffmpegCache;
    const works = (bin) => {
        try { return spawnSync(bin, ['-version'], { timeout: 8000 }).status === 0; } catch { return false; }
    };
    const candidates = [config().story?.ffmpegPath, 'ffmpeg'].filter(Boolean);
    try { candidates.push(require('@ffmpeg-installer/ffmpeg').path); } catch {}
    for (const bin of candidates) if (works(bin)) return (ffmpegCache = bin);
    throw new Error('No working ffmpeg found (tried: ' + candidates.join(', ') + ')');
};

const runFfmpeg = (args) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0
        ? resolve(err)
        : reject(new Error(`ffmpeg exited with code ${code}: ` + err.trim().split('\n').slice(-3).join(' | ').slice(-300)))));
});

// pack name + author inside the sticker (same format as .s)
const stamp = async (webpBuffer) => {
    const { packname, author } = config().sticker || {};
    const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': packname || 'Sticker',
        'sticker-pack-publisher': author || '',
        emojis: ['']
    };
    const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const exif = Buffer.concat([exifAttr, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);
    const img = new webp.Image();
    await img.load(webpBuffer);
    img.exif = exif;
    return await img.save(null);
};

// height of the bubble png, read straight from its header (no image library needed)
const bubbleHeight = () => {
    const head = fs.readFileSync(BUBBLE).subarray(0, 24);
    if (head.toString('ascii', 1, 4) !== 'PNG') throw new Error('library/assets/bubble.png is not a valid PNG');
    return head.readUInt32BE(20);
};

// picture (input 0) goes under the bubble (input 1):
//   top of the sticker: bubble, tail pointing down
//   below it:           the picture, centered in the remaining area
const toWebp = async ({ input, output, animated, crop, q, fps }) => {
    const picTop = bubbleHeight() - OVERLAP;
    const picH = SIZE - picTop;
    const fit = crop
        ? `scale=${SIZE}:${picH}:force_original_aspect_ratio=increase,crop=${SIZE}:${picH}`
        : `scale=${SIZE}:${picH}:force_original_aspect_ratio=decrease`;
    const rate = animated ? fps : 1;
    const graph = [
        `[0:v]${animated ? `fps=${fps},` : ''}${fit},format=rgba[pic]`,
        `color=c=black@0.0:s=${SIZE}x${SIZE}:r=${rate},format=rgba[bg]`,
        `[bg][pic]overlay=(W-w)/2:${picTop}+(${picH}-h)/2:shortest=1:format=auto[base]`,
        `[1:v]format=rgba[bub]`,
        `[base][bub]overlay=0:0:format=auto,format=rgba[out]`
    ].join(';');

    const args = ['-y', '-hide_banner', '-i', input, '-i', BUBBLE, '-filter_complex', graph, '-map', '[out]'];
    if (animated) args.push('-t', String(MAX_SECONDS), '-an');
    else args.push('-frames:v', '1');
    args.push('-c:v', 'libwebp', '-lossless', '0', '-quality', String(q), '-compression_level', '6', '-preset', 'default');
    if (animated) args.push('-loop', '0');
    args.push(output);
    await runFfmpeg(args);
};

const isImageOrVideo = (mime) => /^(image|video)\//.test(mime || '');

module.exports = {
    command: 'sc',
    description: 'Make a sticker with a speech bubble on top (reply to an image, or send it with the caption .sc)',
    category: 'sticker',
    execute: async (sock, m, { quoted, mime, text, reply, prefix }) => {
        const t0 = Date.now();
        const mtype = quoted?.mtype;
        const supported = ['imageMessage', 'videoMessage', 'stickerMessage', 'documentMessage'];

        if (!supported.includes(mtype) || (mtype !== 'documentMessage' && !isImageOrVideo(mime))) {
            return reply(
                `*Bubble sticker*\n\n` +
                `Send a photo with the caption ${prefix}sc\n` +
                `or reply to a photo with ${prefix}sc\n\n` +
                `${prefix}sc crop  ->  picture fills its whole area (center-cropped)\n` +
                `GIFs and videos work too (first ${MAX_SECONDS} seconds).`
            );
        }
        if (!fs.existsSync(BUBBLE)) {
            return reply('The bubble image is missing: library/assets/bubble.png');
        }

        const crop = /\bcrop\b/i.test(text || '');
        log(`New request (${mtype.replace('Message', '')}${mime ? `, ${mime}` : ''}${crop ? ', crop' : ''})`);
        await sock.sendMessage(m.chat, { react: { text: '⏳', key: m.key } }).catch(() => {});

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
        try {
            // ---- 1. download
            log('Downloading media from WhatsApp...');
            const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(quoted.msg || quoted, mtype.replace('Message', ''));
            const chunks = [];
            let size = 0;
            for await (const chunk of stream) {
                chunks.push(chunk);
                size += chunk.length;
                if (size > MAX_INPUT_MB * 1024 * 1024) {
                    await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
                    return reply(`That file is too big for a sticker (limit ${MAX_INPUT_MB} MB).`);
                }
            }
            const buffer = Buffer.concat(chunks);
            const type = await FileType.fromBuffer(buffer);
            const realMime = type?.mime || mime || '';
            log(`Downloaded ${(size / 1024 / 1024).toFixed(2)} MB (${realMime || 'unknown type'})`, 'ok');

            if (!isImageOrVideo(realMime)) {
                await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
                return reply(`That file is not an image, GIF or video (detected: ${realMime || 'unknown'}).`);
            }
            if (realMime === 'image/webp' && isAnimatedWebp(buffer)) {
                await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
                return reply('Animated stickers can\'t get a bubble. Send the original GIF/video instead.');
            }

            // ---- 2. convert (lower the quality step by step until it fits WhatsApp's size limit)
            const animated = /^video\//.test(realMime) || realMime === 'image/gif';
            const input = path.join(dir, 'input.bin');
            const output = path.join(dir, 'sticker.webp');
            fs.writeFileSync(input, buffer);

            const steps = animated ? ANIMATED_STEPS : STATIC_STEPS;
            const limit = (animated ? ANIMATED_MAX_KB : STATIC_MAX_KB) * 1024;
            log(`Building ${animated ? 'animated' : 'static'} sticker with bubble${crop ? ' (cropped)' : ''}...`);

            let best = null;
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                await toWebp({ input, output, animated, crop, ...step });
                const out = fs.readFileSync(output);
                log(`Quality ${step.q}${animated ? `, ${step.fps}fps` : ''}: ${kb(out.length)} (limit ${kb(limit)})`);
                if (!best || out.length < best.length) best = out;
                if (out.length <= limit) { best = out; break; }
            }
            if (best.length > limit) log(`Could not get it under ${kb(limit)} (smallest is ${kb(best.length)}), sending anyway`, 'warn');
            const result = await stamp(best);

            // ---- 3. send
            await sock.sendMessage(m.chat, { sticker: result }, { quoted: m });
            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } }).catch(() => {});
            log(`Done! Total time ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`FAILED: ${e.message || e}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
            const unreadable = /Invalid data|Error opening input|moov atom|could not find codec/i.test(e.message || '');
            await reply(unreadable
                ? `Couldn't make the sticker: that file looks corrupt or isn't a supported image/video.`
                : `Couldn't make the sticker: ${String(e.message || e).split('\n')[0].slice(0, 200)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
