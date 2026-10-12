// .dc = download a Discord media link and send it to the owner's number.
//
//   .dc https://media.discordapp.net/attachments/123/456/attachment.gif?ex=...&is=...&hm=...
//   .dc https://cdn.discordapp.com/attachments/123/456/photo.png?ex=...&is=...&hm=...
//
// Works with images, GIFs, videos, audio and any other file.
// - GIFs are converted to MP4 so WhatsApp plays them as real animated GIFs.
// - Keep the WHOLE link (including ?ex=...&is=...&hm=...). Discord signs those links
//   and they expire after a while, so an old link may return 403/404.
// - Only Discord hosts are accepted (so this can't be used to fetch random URLs).

const axios = require('axios');
const FileType = require('file-type');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('dc');

const MAX_MB = 100; // refuse files bigger than this
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const URL_RE = /https?:\/\/\S+/i;

// ---- only Discord's CDN hosts
const isDiscordHost = (host) => {
    host = String(host || '').toLowerCase();
    return host === 'discordapp.com' || host === 'discordapp.net' ||
        host.endsWith('.discordapp.com') || host.endsWith('.discordapp.net') ||
        host === 'cdn.discordapp.com' || host === 'media.discordapp.net';
};

// ---- find a working ffmpeg (system first, then the bundled one)
let ffmpegCache = null;
const ffmpegBin = () => {
    if (ffmpegCache) return ffmpegCache;
    const candidates = ['ffmpeg'];
    try { candidates.push(require('@ffmpeg-installer/ffmpeg').path); } catch {}
    for (const bin of candidates) {
        try {
            if (spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0) return (ffmpegCache = bin);
        } catch {}
    }
    throw new Error('ffmpeg not found');
};

// ---- GIF -> MP4 (WhatsApp plays an mp4 sent with gifPlayback as an animated GIF)
const gifToMp4 = async (buffer) => {
    const id = crypto.randomBytes(6).toString('hex');
    const input = path.join(os.tmpdir(), `dc_${id}.gif`);
    const output = path.join(os.tmpdir(), `dc_${id}.mp4`);
    await fs.promises.writeFile(input, buffer);
    try {
        await new Promise((resolve, reject) => {
            let err = '';
            const p = spawn(ffmpegBin(), [
                '-y', '-i', input,
                '-movflags', 'faststart',
                '-pix_fmt', 'yuv420p',
                // mp4/h264 needs even width and height
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-an',
                output
            ]);
            p.stderr.on('data', (d) => (err += d.toString()));
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.trim().split('\n').slice(-2).join(' ')))));
        });
        return await fs.promises.readFile(output);
    } finally {
        fs.promises.unlink(input).catch(() => {});
        fs.promises.unlink(output).catch(() => {});
    }
};

const fileNameFrom = (u, ext) => {
    let name = '';
    try { name = decodeURIComponent(path.basename(new URL(u).pathname)); } catch {}
    if (!name || !name.includes('.')) name = `discord_media${ext ? '.' + ext : ''}`;
    return name;
};

module.exports = {
    command: 'dc',
    description: 'Download a Discord media link and send it to the owner',
    category: 'downloader',
    owner: true,
    execute: async (sock, m, { text, reply, prefix, config }) => {
        const link = (String(text || '').match(URL_RE) || [])[0];
        if (!link) {
            return reply(`Send a Discord media link.\nExample: ${prefix}dc https://media.discordapp.net/attachments/.../attachment.gif?ex=...&is=...&hm=...`);
        }

        let url;
        try { url = new URL(link); } catch { return reply('That link is not valid.'); }
        if (!isDiscordHost(url.hostname)) {
            return reply('Only Discord links are supported (cdn.discordapp.com / media.discordapp.net).');
        }

        const ownerJid = String(config.owner).replace(/\D/g, '') + '@s.whatsapp.net';
        const t0 = Date.now();
        log(`New request: ${url.origin}${url.pathname}`);
        await sock.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });

        // ---- download (keep the full signed query string exactly as sent)
        let buffer;
        try {
            const res = await axios.get(url.href, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': UA },
                timeout: 60000,
                maxRedirects: 3,
                maxContentLength: MAX_MB * 1024 * 1024,
                maxBodyLength: MAX_MB * 1024 * 1024
            });
            buffer = Buffer.from(res.data);
            log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB in ${secs(t0)}`, 'ok');
        } catch (e) {
            const status = e.response?.status;
            log(`Download failed: ${status || e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            if (status === 403 || status === 404) {
                return reply('Discord refused the link (403/404). It has probably expired, so copy a fresh link from Discord and try again.');
            }
            return reply(`Download failed: ${status ? 'HTTP ' + status : e.message}`);
        }

        if (!buffer.length) {
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply('The download came back empty.');
        }

        // ---- detect the real type from the bytes (the URL extension can lie)
        const type = await FileType.fromBuffer(buffer).catch(() => null);
        const mime = type?.mime || '';
        const ext = type?.ext || '';
        const fileName = fileNameFrom(url.href, ext);
        log(`Detected type: ${mime || 'unknown'}`);

        // ---- send to the owner
        try {
            if (mime === 'image/gif') {
                let sent = false;
                try {
                    const mp4 = await gifToMp4(buffer);
                    await sock.sendMessage(ownerJid, { video: mp4, mimetype: 'video/mp4', gifPlayback: true });
                    sent = true;
                    log('Sent GIF as mp4 (gifPlayback)', 'ok');
                } catch (e) {
                    log(`GIF conversion failed (${e.message}), sending as a file instead`, 'warn');
                }
                if (!sent) {
                    await sock.sendMessage(ownerJid, { document: buffer, mimetype: 'image/gif', fileName });
                }
            } else if (mime.startsWith('image/')) {
                await sock.sendMessage(ownerJid, { image: buffer });
            } else if (mime.startsWith('video/')) {
                await sock.sendMessage(ownerJid, { video: buffer, mimetype: mime });
            } else if (mime.startsWith('audio/')) {
                await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime });
            } else {
                await sock.sendMessage(ownerJid, { document: buffer, mimetype: mime || 'application/octet-stream', fileName });
            }
        } catch (e) {
            log(`Send failed: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Couldn't send the media: ${e.message}`);
        }

        await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        log(`Done. Total time ${secs(t0)}`, 'ok');
    }
};
