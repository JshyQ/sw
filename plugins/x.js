const axios = require('axios');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('x');

// Matches x.com / twitter.com (+ mobile., www.) and the fxtwitter / vxtwitter mirrors.
const X_LINK = /https?:\/\/(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)\/[^\s]+/i;
const STATUS_ID = /\/status(?:es)?\/(\d+)/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SSS = 'https://ssstwitter.com';
const MAX_MB = 100;        // refuse anything bigger than this
const DOC_ABOVE_MB = 60;   // above this, send as a document so WhatsApp doesn't choke on it

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ---------------------------------------------------------------------------
// Source 1: ssstwitter.com
// The site is an htmx page: GET the home page to read the one-time "tt" + "ts" values
// from the form, then POST the tweet url together with them. The reply is an HTML
// fragment that contains one download link per quality.
// ---------------------------------------------------------------------------
const parseSssLinks = (html) => {
    const out = [];
    const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
    for (const a of anchors) {
        const href = (a.match(/href="([^"]+)"/i) || [])[1];
        if (!href) continue;
        const url = decode(href);
        if (!/^https?:\/\//i.test(url)) continue;
        if (/ssstwitter\.com\/?$/i.test(url) || /twitter\.com|x\.com\/[^/]*$/i.test(url)) continue; // site / profile links
        const label = a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // quality: from the label ("Download 720p", "1280x720") or from the url (/720x1280/)
        let height = 0;
        const p = label.match(/(\d{3,4})\s*p/i);
        const wh = (label + ' ' + url).match(/(\d{3,4})x(\d{3,4})/);
        if (p) height = parseInt(p[1], 10);
        else if (wh) height = Math.min(parseInt(wh[1], 10), parseInt(wh[2], 10));
        const looksLikeVideo = /video|mp4|download|\d{3,4}p/i.test(label + ' ' + url);
        if (looksLikeVideo) out.push({ url, height, label });
    }
    return out;
};

const fetchFromSss = async (tweetUrl) => {
    const home = await axios.get(SSS + '/', {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 20000
    });
    const page = String(home.data);
    const tt = (page.match(/tt\s*[=:]\s*['"]?([a-f0-9]{16,})/i) || page.match(/name="tt"[^>]*value="([^"]+)"/i) || [])[1];
    const ts = (page.match(/ts\s*[=:]\s*['"]?(\d{9,})/i) || page.match(/name="ts"[^>]*value="([^"]+)"/i) || [])[1];
    if (!tt || !ts) throw new Error('ssstwitter page layout changed (token not found)');

    const cookie = (home.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const body = new URLSearchParams({ id: tweetUrl, locale: 'en', tt, ts, source: 'form' }).toString();

    const res = await axios.post(SSS + '/', body, {
        headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'HX-Request': 'true',
            'HX-Target': 'target',
            'HX-Current-URL': SSS + '/',
            Origin: SSS,
            Referer: SSS + '/',
            ...(cookie ? { Cookie: cookie } : {})
        },
        timeout: 25000
    });

    const links = parseSssLinks(String(res.data));
    if (!links.length) throw new Error('ssstwitter returned no video links (tweet may have no video)');
    links.sort((a, b) => b.height - a.height);
    return { url: links[0].url, quality: links[0].height ? `${links[0].height}p` : null, caption: null, source: 'ssstwitter' };
};

// ---------------------------------------------------------------------------
// Source 2 (fallback): api.fxtwitter.com - plain JSON, no scraping, very stable.
// Used automatically if ssstwitter is down, blocks the server, or changes its layout.
// ---------------------------------------------------------------------------
const fetchFromFx = async (tweetUrl) => {
    const id = (tweetUrl.match(STATUS_ID) || [])[1];
    if (!id) throw new Error('could not find a tweet id in that link');
    const { data } = await axios.get(`https://api.fxtwitter.com/i/status/${id}`, {
        headers: { 'User-Agent': UA },
        timeout: 20000
    });
    const tweet = data?.tweet;
    if (!tweet) throw new Error(data?.message || 'tweet not found');
    const videos = (tweet.media?.videos || []).filter(v => v.url);
    if (!videos.length) throw new Error('that tweet has no video');
    videos.sort((a, b) => (b.height || 0) - (a.height || 0));
    const best = videos[0];
    const who = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '';
    const caption = [tweet.text, who].filter(Boolean).join('\n\n') || null;
    return { url: best.url, quality: best.height ? `${best.height}p` : null, caption, source: 'fxtwitter' };
};

module.exports = {
    command: 'x',
    description: 'Download an X (Twitter) video in the best quality',
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
        const errors = [];
        for (const [name, fn] of [['ssstwitter', fetchFromSss], ['fxtwitter', fetchFromFx]]) {
            try {
                log(`Trying ${name}...`);
                info = await fn(link);
                log(`Got video link from ${name}${info.quality ? ` (${info.quality})` : ''}`, 'ok');
                break;
            } catch (e) {
                errors.push(`${name}: ${e.message}`);
                log(`${name} failed: ${e.message}`, 'warn');
            }
        }

        if (!info) {
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Couldn't get a video from that link.\n${errors.map(e => '• ' + e).join('\n')}`);
        }

        let buffer;
        log('Downloading video...');
        try {
            const res = await axios.get(info.url, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': UA, Referer: info.source === 'ssstwitter' ? SSS + '/' : 'https://x.com/' },
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
