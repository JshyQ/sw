const axios = require('axios');
const { makeLog, secs } = require('../library/botlog');
const log = makeLog('x');

// Matches x.com / twitter.com (+ mobile., www.) and the fxtwitter / vxtwitter mirrors.
const X_LINK = /https?:\/\/(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)\/[^\s]+/i;
const STATUS_ID = /\/status(?:es)?\/(\d+)/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SITE = 'https://ssstwitter.com/';

// Nothing is re-encoded: the highest rendition X offers is sent byte for byte.
// A cap only affects which rendition is chosen, never the file itself.
const QUALITY_CAP = 0;     // 0 = no cap, send the sharpest available. Set to 720 to prefer 720p.
const MAX_MB = 500;        // refuse anything bigger than this
const DOC_ABOVE_MB = 16;   // above this, a document is the only way to avoid WhatsApp's own re-encode

// Send every video as a document. WhatsApp recompresses video messages, which is
// exactly the quality loss being avoided here, so the default is off for that path.
const ALWAYS_DOCUMENT = true;

const LIMIT_RETRY_MS = 12000;
const LIMIT_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Source: ssstwitter.com. The site is an htmx form: the page carries a token pair
// inside the form's include-vals attribute, and posting the link back to the same
// address returns an HTML fragment with one download button per quality. Each
// button points at the file through data-directurl (the raw ssscdn.io address) or
// href (a redirect). The tokens and the link signature both expire, so the page is
// re-fetched for every request and the download is started straight away.
// ---------------------------------------------------------------------------
const decodeEntities = (s) => s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const attr = (tag, name) => {
    const m = tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
    return m ? decodeEntities(m[1]) : null;
};

const qualityOf = (tag) => {
    const text = tag.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const p = text.match(/(\d{3,4})\s*p\b/i);
    if (p) return Number(p[1]);
    if (/\bhd\b/i.test(text)) return 720;
    if (/\bsd\b/i.test(text)) return 480;
    return null;
};

const ANCHOR = /<a\b[^>]*class=["'][^"']*download-btn[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;

const buttonsIn = (html) => {
    const out = [];
    for (const tag of html.match(ANCHOR) || []) {
        const raw = attr(tag, 'data-directurl') || attr(tag, 'href');
        if (!raw) continue;
        let url;
        try { url = new URL(raw, SITE).toString(); } catch { continue; }
        if (!/^https?:/i.test(url)) continue;
        out.push({
            url,
            quality: qualityOf(tag),
            hinted: /quality-best/i.test(tag)
        });
    }
    return out;
};

// Sharpest rendition available. The quality-best class is the site's own marker for
// its top file, used only when the labels on the buttons cannot be read.
const pickBest = (buttons) => {
    const known = buttons.filter((b) => b.quality);
    const usable = QUALITY_CAP ? known.filter((b) => b.quality <= QUALITY_CAP) : known;
    if (usable.length) return usable.sort((a, b) => b.quality - a.quality)[0];
    if (known.length) return known.sort((a, b) => a.quality - b.quality)[0];
    return buttons.find((b) => b.hinted) || buttons[0] || null;
};

const errorText = (html) => {
    const m = html.match(/id="errorContainer"[^>]*>([\s\S]{0,600})/i);
    const chunk = m ? m[1] : html.slice(0, 600);
    const text = decodeEntities(chunk.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return text.slice(0, 180);
};

const resolveOnce = async (tweetUrl) => {
    const page = await axios.get(SITE, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        timeout: 20000,
        validateStatus: () => true
    });
    const html = String(page.data || '');
    const tt = (html.match(/include-vals="[^"]*tt:'([^']+)'/) || [])[1];
    const ts = (html.match(/include-vals="[^"]*ts:(\d+)/) || [])[1];
    if (!tt || !ts) throw new Error('the downloader page did not hand out a token');

    const cookie = [].concat(page.headers['set-cookie'] || [])
        .map((c) => String(c).split(';')[0])
        .join('; ');

    const res = await axios.post(SITE, new URLSearchParams({
        id: tweetUrl,
        tt,
        ts,
        source: 'form'
    }).toString(), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'hx-request': 'true',
            'hx-target': 'target',
            'hx-current-url': SITE,
            origin: 'https://ssstwitter.com',
            referer: SITE,
            'user-agent': UA,
            ...(cookie ? { cookie } : {})
        },
        timeout: 40000,
        maxContentLength: 4 * 1024 * 1024,
        validateStatus: () => true
    });

    const body = String(res.data || '');
    const buttons = buttonsIn(body);
    const limited = /too fast|limit-exceed|wait ~\d+/i.test(body);
    return { buttons, body, limited };
};

// The site throttles repeated submissions, so a throttled answer is retried once
// after its own suggested pause rather than surfaced to the user.
const fetchFromSsstwitter = async (tweetUrl) => {
    let last = { buttons: [], body: '', limited: false };
    for (let attempt = 1; attempt <= LIMIT_ATTEMPTS; attempt++) {
        last = await resolveOnce(tweetUrl);
        if (last.buttons.length) break;
        if (last.limited && attempt < LIMIT_ATTEMPTS) {
            log(`ssstwitter is throttling, waiting ${LIMIT_RETRY_MS / 1000}s before retry`, 'warn');
            await new Promise((r) => setTimeout(r, LIMIT_RETRY_MS));
        } else {
            break;
        }
    }

    if (!last.buttons.length) {
        const why = errorText(last.body);
        throw new Error(last.limited
            ? 'the downloader is rate limiting, try again in a few seconds'
            : (why || 'the downloader returned no video for that link'));
    }

    const best = pickBest(last.buttons);
    return {
        url: best.url,
        quality: best.quality,
        qualityLabel: best.quality ? `${best.quality}p` : null
    };
};

// ssstwitter returns no caption text, so the tweet wording is fetched separately
// and quietly skipped when that fails.
const captionFromFx = async (tweetUrl) => {
    const id = (tweetUrl.match(STATUS_ID) || [])[1];
    if (!id) return null;
    try {
        const { data } = await axios.get(`https://api.fxtwitter.com/i/status/${id}`, {
            headers: { 'User-Agent': UA },
            timeout: 8000
        });
        const tweet = data?.tweet;
        if (!tweet) return null;
        const who = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '';
        return [tweet.text, who].filter(Boolean).join('\n\n') || null;
    } catch {
        return null;
    }
};

module.exports = {
    command: 'x',
    description: 'Download an X (Twitter) video at full quality, untouched',
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
            log('Resolving through ssstwitter...');
            const found = await fetchFromSsstwitter(link);
            info = { ...found, caption: null, source: 'ssstwitter' };
            log(`Got video link from ssstwitter${info.qualityLabel ? ` (${info.qualityLabel})` : ''}`, 'ok');
        } catch (e) {
            log(`ssstwitter failed: ${e.message}`, 'warn');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Couldn't get a video from that link.\n• ssstwitter: ${e.message}`);
        }

        info.caption = await captionFromFx(link);

        let buffer;
        log('Downloading video...');
        try {
            const res = await axios.get(info.url, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': UA, Referer: SITE },
                timeout: 120000,
                maxContentLength: MAX_MB * 1024 * 1024,
                maxBodyLength: MAX_MB * 1024 * 1024
            });
            buffer = Buffer.from(res.data);
            log(`Video downloaded: ${(buffer.length / 1024 / 1024).toFixed(2)} MB in ${secs(t0)}`, 'ok');
        } catch (e) {
            log(`Download failed: ${e.message}`, 'err');
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`Download failed: ${e.message}`);
        }

        const mb = buffer.length / 1024 / 1024;
        if (mb > MAX_MB) {
            await sock.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`That file is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB limit.`);
        }

        const caption = info.caption ? info.caption.slice(0, 900) : undefined;

        log(`Sending to chat as ${ALWAYS_DOCUMENT || mb > DOC_ABOVE_MB ? 'document' : 'video'}...`);
        if (ALWAYS_DOCUMENT || mb > DOC_ABOVE_MB) {
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
