// .swl <tiktok link> [caption]
// Downloads the TikTok video (no watermark, best quality) and posts it straight to your
// story. The video is NEVER sent to the chat - only reactions and one short status message.
//
//   .swl https://vt.tiktok.com/xxxxxxx/
//   .swl https://vt.tiktok.com/xxxxxxx/ my caption here     (optional caption)
//   reply to a message that contains the link with .swl

const axios = require('axios');
const { makeLog, secs } = require('../library/botlog');
const { postStory, audienceSize } = require('../library/story');
const log = makeLog('swl');

const TT_LINK = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAX_MB = 100;
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

// same source as .tt: tikwm.com. hd=1 asks for the best quality; play / hdplay are watermark-free.
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
    command: 'swl',
    description: 'Post a TikTok video link straight to your story (no video sent to chat)',
    category: 'story',
    owner: true,
    execute: async (sock, m, { text, reply, prefix }) => {
        const source = `${text || ''} ${m.quoted?.text || ''}`;
        const link = (source.match(TT_LINK) || [])[0];
        if (!link) {
            return reply(
                `*TikTok link to story*\n\n` +
                `${prefix}swl https://vt.tiktok.com/xxxxxxx/\n` +
                `${prefix}swl <link> your caption   (optional caption)\n` +
                `or reply to a message that contains the link with ${prefix}swl\n\n` +
                `Story audience: ${audienceSize()} contacts (+ you)`
            );
        }
        // anything written after the link in the command is used as the story caption
        const caption = (text || '').replace(link, '').trim() || undefined;

        const react = (emoji) => sock.sendMessage(m.chat, { react: { text: emoji, key: m.key } }).catch(() => {});
        const t0 = Date.now();
        log(`New request: ${link}`);
        await react('⬇️');

        try {
            // ---- 1. get the video
            log('Fetching post info from tikwm...');
            const info = await fetchInfo(link);
            log('Post info received', 'ok');

            if (info.images?.length) {
                await react('❌');
                return reply(`That TikTok is a photo slideshow (${info.images.length} images), not a video. Nothing was posted.`);
            }
            const videoUrl = abs(info.hdplay) || abs(info.play);
            if (!videoUrl) {
                await react('❌');
                return reply('No downloadable video found for that link. Nothing was posted.');
            }

            log('Downloading video (no watermark)...');
            const res = await axios.get(videoUrl, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/' },
                timeout: 90000,
                maxContentLength: MAX_MB * 1024 * 1024
            });
            const buffer = Buffer.from(res.data);
            log(`Video downloaded: ${mb(buffer.length)} in ${secs(t0)}`, 'ok');

            // ---- 2. post it to the story (nothing is sent to the chat)
            await react('⬆️');
            log(`Uploading to your story (${mb(buffer.length)}, video)...`);
            const tu = Date.now();
            const { recipients } = await postStory(sock, { buffer, mimetype: 'video/mp4', caption, log });
            log(`Story posted to ${recipients} recipients in ${secs(tu)}. Total time ${secs(t0)}`, 'ok');

            await react('✅');
            await reply(`Story posted (${mb(buffer.length)}, ${recipients} recipients)`);
        } catch (e) {
            log(`FAILED: ${e.message || e}`, 'err');
            await react('❌');
            await reply(`Couldn't post that TikTok to your story: ${String(e.message || e).split('\n')[0].slice(0, 200)}`);
        }
    }
};
