// .sws = split a long video into several story parts (90s each, or less) and post them in order.
//
// Why the cuts are clean: instead of copying the stream and cutting on whatever keyframe happens to
// be nearest (which gives parts of uneven length and small jumps), every part is encoded on its own
// with an exact start time and an exact length. Part 2 starts at the very frame after part 1 ends,
// same resolution, and each part begins with its own keyframe (no frozen frame / glitch at the start).

const FileType = require('file-type');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { postStory, audienceSize } = require('../library/story');
const chalk = require('chalk');

const PART_SECONDS = 90;   // max length of one story part
const MIN_LAST = 5;        // if the leftover last part would be shorter than this, spread the length evenly instead
const CRF = 20;            // video quality (lower = better quality, bigger file; 18 = near lossless, 23 = smaller)
const PRESET = 'veryfast'; // encoding speed (slower presets give smaller files, but take longer)
const AUDIO_KBPS = 160;
const DELAY_BETWEEN_POSTS = 1500; // ms, keeps the parts in the right order on the story

// Terminal progress messages (cyan = running, green = done, yellow = warning, red = failure).
const COLORS = { info: chalk.cyan, ok: chalk.green, warn: chalk.yellow, err: chalk.red };
const log = (msg, kind = 'info') => {
    const time = new Date().toLocaleTimeString('en-GB');
    console.log(chalk.gray(`[${time}]`), (COLORS[kind] || COLORS.info)('[sws]'), msg);
};
const secs = (start) => ((Date.now() - start) / 1000).toFixed(1) + 's';
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';
const config = () => require('../settings/config');
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVideoMime = (t) => /^video\//.test(t || '');

// Same lookup order as the rest of the bot: config.story.ffmpegPath -> system ffmpeg -> bundled binary.
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

// Duration / size / audio presence from `ffmpeg -i` (no ffprobe needed).
const probeVideo = (file) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => {
        const dur = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const vid = err.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
        if (!dur || !vid) return reject(new Error('Could not read video info (is it a valid video?)'));
        resolve({
            seconds: (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]),
            width: +vid[1],
            height: +vid[2],
            hasAudio: /Stream #\d+:\d+.*Audio:/.test(err)
        });
    });
});

// How long each part is. Normally PART_SECONDS, but if that would leave a tiny leftover at the end
// (e.g. 3:03 -> 90 + 90 + 3s) the length is spread evenly instead (3 parts of about 61s).
const planParts = (seconds) => {
    const n = Math.ceil(seconds / PART_SECONDS);
    const leftover = seconds - (n - 1) * PART_SECONDS;
    if (n > 1 && leftover < MIN_LAST) {
        return { parts: n, length: seconds / n, even: true };
    }
    return { parts: n, length: PART_SECONDS, even: false };
};

module.exports = {
    command: 'sws',
    description: 'Split a long video into story parts of 90s (or less) and post them in order',
    category: 'story',
    owner: true,
    execute: async (sock, m, { quoted, mime, text, reply, prefix }) => {
        const t0 = Date.now();
        log('New request');

        const mtype = quoted?.mtype;
        const isDoc = mtype === 'documentMessage';
        if (!['videoMessage', 'documentMessage'].includes(mtype) || (!isDoc && !isVideoMime(mime))) {
            log('No video found in the message, sent usage help', 'warn');
            return reply(
                `*Split a long video into story parts*\n\n` +
                `Send the video as a *Document* (attach > Document) with caption ${prefix}sws\n` +
                `or reply to it with ${prefix}sws\n\n` +
                `Every part is ${PART_SECONDS}s or less and posted in order, cut exactly where the last one ended.\n` +
                `Optional caption: ${prefix}sws your caption\n\n` +
                `Story audience: ${audienceSize()} contacts (+ you)`
            );
        }

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sws-'));
        try {
            // ---- 1. download the original video
            await reply('Downloading...');
            log(`Downloading ${isDoc ? 'document' : 'video'} from WhatsApp...`);
            const dlStart = Date.now();
            const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(quoted.msg || quoted, mtype.replace('Message', ''));

            const chunks = [];
            let size = 0;
            let checked = isVideoMime(mime); // only sniff when WhatsApp didn't label it as video
            for await (const chunk of stream) {
                chunks.push(chunk);
                size += chunk.length;
                if (!checked && size >= 4100) {
                    checked = true;
                    const t = await FileType.fromBuffer(Buffer.concat(chunks));
                    if (!t || !isVideoMime(t.mime)) { // stop early, don't pull 200MB of something else
                        log(`File is not a video (detected: ${t ? t.mime : 'unknown'}), stopping`, 'err');
                        return reply(`That file is not a video (detected: ${t ? t.mime : 'unknown'}).`);
                    }
                }
            }
            const input = path.join(dir, 'input.bin');
            fs.writeFileSync(input, Buffer.concat(chunks));
            chunks.length = 0;
            log(`Downloaded ${mb(size)} in ${secs(dlStart)}`, 'ok');

            // ---- 2. work out how to split it
            log('Reading video info...');
            const info = await probeVideo(input);
            log(`Video is ${fmt(info.seconds)} (${info.seconds.toFixed(1)}s), ${info.width}x${info.height}${info.hasAudio ? '' : ', no audio'}`);

            if (info.seconds <= PART_SECONDS) {
                log(`Video is only ${fmt(info.seconds)}, no need to split (max ${PART_SECONDS}s per story). Use .sw instead`, 'warn');
                return reply(`This video is only ${fmt(info.seconds)}, it fits in one story (max ${fmt(PART_SECONDS)}). Use ${prefix}sw for it.`);
            }

            const plan = planParts(info.seconds);
            log(plan.even
                ? `Splitting into ${plan.parts} equal parts of about ${plan.length.toFixed(1)}s (so the last part isn't a tiny leftover)`
                : `Splitting into ${plan.parts} parts of ${PART_SECONDS}s (last one ${(info.seconds - (plan.parts - 1) * PART_SECONDS).toFixed(1)}s)`);
            await reply(`Video is ${fmt(info.seconds)}. Cutting it into ${plan.parts} story parts, this can take a few minutes...`);

            // ---- 3. cut: every part is encoded separately with an exact start and length
            log('Encoding the parts with ffmpeg (exact cuts, same resolution, this is the slow part)...');
            const encStart = Date.now();
            const L = plan.length;
            // Cut points sit 1 ms BEFORE each boundary, so a frame that lands exactly on a boundary always
            // belongs to the next part (never to both = no repeated frame, never to neither = no lost frame).
            const starts = Array.from({ length: plan.parts }, (_, i) => (i === 0 ? 0 : i * L - 0.001));
            const files = [];
            for (let i = 0; i < plan.parts; i++) {
                const out = path.join(dir, `part_${String(i + 1).padStart(3, '0')}.mp4`);
                const partStart = Date.now();
                log(`Encoding part ${i + 1}/${plan.parts}...`);
                await runFfmpeg([
                    '-y', '-hide_banner',
                    '-ss', starts[i].toFixed(3), '-i', input, // frame-accurate start (we re-encode, so no keyframe snapping)
                    '-t', (i < plan.parts - 1 ? starts[i + 1] - starts[i] : L).toFixed(3), // exact length (last part ends where the video ends)
                    '-map', '0:v:0', '-map', '0:a?',
                    '-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF), '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
                    '-movflags', '+faststart',
                    out
                ]);
                files.push(path.basename(out));
                log(`Part ${i + 1}/${plan.parts} encoded in ${secs(partStart)} (${mb(fs.statSync(out).size)})`, 'ok');
            }
            fs.rmSync(input, { force: true }); // free disk space, the parts are all we need now
            log(`All ${files.length} parts encoded in ${secs(encStart)}`, 'ok');

            // ---- 4. post the parts in order (one at a time so only one is in memory)
            let posted = 0;
            for (let i = 0; i < files.length; i++) {
                const file = path.join(dir, files[i]);
                const buffer = fs.readFileSync(file);
                log(`Uploading part ${i + 1}/${files.length} (${mb(buffer.length)})...`);
                const upStart = Date.now();
                try {
                    await postStory(sock, { buffer, mimetype: 'video/mp4', caption: text });
                } catch (e) {
                    log(`Part ${i + 1}/${files.length} failed to upload: ${e.message || e}`, 'err');
                    await reply(`Part ${i + 1}/${files.length} failed to upload: ${e.message || e}\nParts 1-${posted} are already on your story.`);
                    return;
                }
                posted++;
                log(`Part ${i + 1}/${files.length} posted in ${secs(upStart)}`, 'ok');
                if (i < files.length - 1) await sleep(DELAY_BETWEEN_POSTS);
            }

            await reply(`Story posted in ${posted} parts (${fmt(info.seconds)} total).`);
            log(`Done! ${posted} parts posted. Total time ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`FAILED: ${e.message || e}`, 'err');
            console.log(e);
            await reply(`Failed: ${e.message || e}`);
        } finally {
            log('Cleaning up temp files');
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
};
