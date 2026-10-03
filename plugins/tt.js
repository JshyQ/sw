const axios = require('axios');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('tt');

const TT_LINK = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// tikwm.com's public endpoint. hd=1 asks for the best available quality; "play"/"hdplay"
// are already watermark-free (TikTok's native download, not a re-rendered copy).
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

const abs = (u) => (u && u.startsWith('http') ? u : u ? 'https://www.tikwm.com' + u : null);

module.exports = {
    command: 'tt',
    description: 'Download a TikTok video, no watermark, best quality',
    category: 'downloader',
    execute: async (sock, m, { text, reply, prefix }) => {
        const link = (text.match(TT_LINK) || [])[0];
        if (!link) {
            return reply(`Send a TikTok link.\nExample: ${prefix}tt https://vt.tiktok.com/xxxxxxx/`);
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

        if (info.images?.length) {
            log(`Photo post (${info.images.length} images), sending the images one by one...`);
            // TikTok "photo mode" posts have no single video — send the slideshow images instead.
            await reply(`This is a photo slideshow (${info.images.length} images), not a video. Sending images...`);
            for (const img of info.images) {
                await sock.sendMessage(m.chat, { image: { url: abs(img) } }, { quoted: m });
            }
            await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
            log(`Images sent. Total time ${secs(t0)}`, 'ok');
            return;
        }

        const videoUrl = abs(info.hdplay) || abs(info.play);
        if (!videoUrl) {
            log('No downloadable video found', 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply('No downloadable video found for that link.');
        }

        let buffer;
        log('Downloading video (no watermark)...');
        try {
            const res = await axios.get(videoUrl, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/' },
                timeout: 60000,
                maxContentLength: 200 * 1024 * 1024
            });
            buffer = Buffer.from(res.data);
            log(`Video downloaded: ${(buffer.length / 1024 / 1024).toFixed(2)} MB in ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`Download failed: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Download failed: ${e.message}`);
        }

        const caption = info.title ? `${info.title}${info.author?.nickname ? `\n\n🎵 @${info.author.unique_id || info.author.nickname}` : ''}` : undefined;

        log('Sending video to chat...');
        await sock.sendMessage(m.chat, {
            video: buffer,
            mimetype: 'video/mp4',
            caption
        }, { quoted: m });

        await sock.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        log(`Done! Total time ${secs(t0)}`, 'ok');
    }
};
