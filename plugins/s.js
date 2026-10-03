// .s = turn an image / GIF / video into a WhatsApp sticker.
//
//   Send a photo, GIF or video with the caption .s       -> sticker
//   Reply to a photo, GIF, video or sticker with .s      -> sticker
//   .s crop                                              -> fills the whole square (center-cropped)
//                                                           instead of fitting the whole picture
//
// Pack name / author come from config.sticker (settings/config.js).
// Images become static stickers, GIFs and videos become animated stickers (first 10 seconds).
// Animated .webp files are first converted to .mp4 with CloudConvert (needs CLOUDCONVERT_API_KEY in .env).
// The quality is lowered step by step until the file is small enough for WhatsApp (static 100 KB,
// animated 500 KB), so a big GIF or video still turns into a sticker that actually sends.

const FileType = require('file-type');
const webp = require('node-webpmux');
const chalk = require('chalk');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { webpToMp4, isAnimatedWebp } = require('../library/cloudconvert');

const SHOW_LOGS = true;      // terminal progress messages (set to false to silence this command)
const MAX_INPUT_MB = 50;     // refuse files bigger than this
const MAX_SECONDS = 10;      // animated stickers: only the first 10 seconds are used
const STATIC_MAX_KB = 100;   // WhatsApp's size limit for static stickers
const ANIMATED_MAX_KB = 500; // WhatsApp's size limit for animated stickers
const SIZE = 512;            // stickers are 512x512

// Quality steps, tried in order until the file fits. (fps only applies to animated stickers)
const STATIC_STEPS = [{ q: 80 }, { q: 65 }, { q: 50 }, { q: 35 }, { q: 20 }];
const ANIMATED_STEPS = [
    { q: 55, fps: 15 }, { q: 40, fps: 15 }, { q: 30, fps: 12 }, { q: 20, fps: 10 }, { q: 10, fps: 8 }
];

// ---- terminal messages (cyan = running, green = done, yellow = warning, red = failure)
const COLORS = { info: chalk.cyan, ok: chalk.green, warn: chalk.yellow, err: chalk.red };
const log = (msg, kind = 'info') => {
    if (!SHOW_LOGS) return;
    const time = new Date().toLocaleTimeString('en-GB');
    console.log(chalk.gray(`[${time}]`), (COLORS[kind] || COLORS.info)('[s]'), msg);
};
const secs = (start) => ((Date.now() - start) / 1000).toFixed(1) + 's';
const kb = (bytes) => (bytes / 1024).toFixed(0) + ' KB';

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
        : reject(new Error(`ffmpeg exited with code ${code}: ` + err.trim().split('\n').slice(-3).join(' | ').slice(-300)))));
});

// ---- pack name + author inside the sticker (same format the rest of the bot uses)
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

// Picture -> 512x512 webp. Default keeps the whole picture (transparent bars around it);
// crop = true fills the whole square instead.
const toWebp = async ({ input, output, animated, crop, q, fps }) => {
    const fit = crop
        ? `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE},format=rgba`
        : `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
    const args = ['-y', '-hide_banner', '-i', input];
    if (animated) args.push('-t', String(MAX_SECONDS), '-an');
    args.push('-vf', animated ? `fps=${fps},${fit}` : fit);
    if (!animated) args.push('-frames:v', '1');
    args.push('-c:v', 'libwebp', '-lossless', '0', '-quality', String(q), '-compression_level', '6', '-preset', 'default');
    if (animated) args.push('-loop', '0');
    args.push(output);
    await runFfmpeg(args);
};

const isImageOrVideo = (mime) => /^(image|video)\//.test(mime || '');

module.exports = {
    command: 's',
    description: 'Turn an image, GIF or video into a sticker (reply to it, or send it with the caption .s)',
    category: 'sticker',
    execute: async (sock, m, { quoted, mime, text, reply, prefix }) => {
        const t0 = Date.now();
        const mtype = quoted?.mtype;
        const supported = ['imageMessage', 'videoMessage', 'stickerMessage', 'documentMessage'];

        if (!supported.includes(mtype) || (mtype !== 'documentMessage' && !isImageOrVideo(mime))) {
            log('No image/GIF/video found in the message, sent usage help', 'warn');
            return reply(
                `*Sticker maker*\n\n` +
                `Send a photo, GIF or video with the caption ${prefix}s\n` +
                `or reply to one with ${prefix}s\n\n` +
                `${prefix}s crop  ->  fill the whole square (center-cropped)\n` +
                `Videos and GIFs: the first ${MAX_SECONDS} seconds are used.`
            );
        }

        const crop = /\bcrop\b/i.test(text || '');
        log(`New request (${mtype.replace('Message', '')}${mime ? `, ${mime}` : ''}${crop ? ', crop' : ''})`);
        await sock.sendMessage(m.chat, { react: { text: '⏳', key: m.key } }).catch(() => {});

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-'));
        try {
            // ---- 1. download
            log('Downloading media from WhatsApp...');
            const dlStart = Date.now();
            const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(quoted.msg || quoted, mtype.replace('Message', ''));
            const chunks = [];
            let size = 0;
            for await (const chunk of stream) {
                chunks.push(chunk);
                size += chunk.length;
                if (size > MAX_INPUT_MB * 1024 * 1024) {
                    log(`File is bigger than ${MAX_INPUT_MB} MB, stopping`, 'err');
                    await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
                    return reply(`That file is too big for a sticker (limit ${MAX_INPUT_MB} MB).`);
                }
            }
            const buffer = Buffer.concat(chunks);
            const type = await FileType.fromBuffer(buffer);
            const realMime = type?.mime || mime || '';
            log(`Downloaded ${(size / 1024 / 1024).toFixed(2)} MB (${realMime || 'unknown type'}) in ${secs(dlStart)}`, 'ok');

            if (!isImageOrVideo(realMime)) {
                log(`File is not an image/GIF/video (detected: ${realMime || 'unknown'}), stopping`, 'err');
                await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
                return reply(`That file is not an image, GIF or video (detected: ${realMime || 'unknown'}).`);
            }

            // ---- 2. already a sticker: only put the pack name / author on it (keeps animation as is)
            let result;
            if (mtype === 'stickerMessage') {
                log('Already a sticker, just updating the pack name / author...');
                result = await stamp(buffer);
            } else {
                // ---- 3. convert
                let inputBuffer = buffer;
                let inputMime = realMime;

                // An animated .webp (sent as a file, not as a sticker) can't be read frame by frame by ffmpeg,
                // so CloudConvert turns it into an .mp4 first, then the normal video -> sticker steps run.
                if (realMime === 'image/webp' && isAnimatedWebp(buffer)) {
                    log('Animated .webp detected, converting to .mp4 with CloudConvert...');
                    const ccStart = Date.now();
                    try {
                        inputBuffer = await webpToMp4(buffer);
                        inputMime = 'video/mp4';
                        log(`CloudConvert done: ${kb(inputBuffer.length)} mp4 in ${secs(ccStart)}`, 'ok');
                    } catch (e) {
                        log(`${e.message} - falling back to the first frame only`, 'warn');
                    }
                }

                const animated = /^video\//.test(inputMime) || inputMime === 'image/gif';
                const input = path.join(dir, 'input.bin');
                const output = path.join(dir, 'sticker.webp');
                fs.writeFileSync(input, inputBuffer);

                const steps = animated ? ANIMATED_STEPS : STATIC_STEPS;
                const limit = (animated ? ANIMATED_MAX_KB : STATIC_MAX_KB) * 1024;
                log(`Converting to ${animated ? 'an animated' : 'a static'} sticker${crop ? ' (cropped)' : ''}...`);

                let best = null;
                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];
                    const encStart = Date.now();
                    await toWebp({ input, output, animated, crop, ...step });
                    const out = fs.readFileSync(output);
                    log(`Quality ${step.q}${animated ? `, ${step.fps}fps` : ''}: ${kb(out.length)} (limit ${kb(limit)}) in ${secs(encStart)}`);
                    if (!best || out.length < best.length) best = out;
                    if (out.length <= limit) { best = out; break; }
                    if (i < steps.length - 1) log('Too big for WhatsApp, lowering the quality and trying again...', 'warn');
                }
                if (best.length > limit) log(`Could not get it under ${kb(limit)} (smallest is ${kb(best.length)}), sending it anyway`, 'warn');
                result = await stamp(best);
            }

            // ---- 4. send
            log(`Sending sticker (${kb(result.length)})...`);
            await sock.sendMessage(m.chat, { sticker: result }, { quoted: m });
            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } }).catch(() => {});
            log(`Done! Total time ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`FAILED: ${e.message || e}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
            // keep ffmpeg's technical output in the terminal, don't dump it in the chat
            const unreadable = /Invalid data|Error opening input|moov atom|could not find codec/i.test(e.message || '');
            await reply(unreadable
                ? `Couldn't make the sticker: that file looks corrupt or isn't a supported image/video.`
                : `Couldn't make the sticker: ${String(e.message || e).split('\n')[0].slice(0, 200)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
