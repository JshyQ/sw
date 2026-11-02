const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

// ssstwitter.com is the download website this plugin scrapes.
const BASE_URL = 'https://ssstwitter.com/';

// ssstwitter's homepage is an htmx app: pasting a link fires an htmx POST to
// "/" instead of a normal <form> submit. That's why the old version of this
// file (which looked for a plain <form> tag in the homepage's HTML) never
// found anything to submit. This is the "current URL" htmx reports back for
// that POST today — if ssstwitter changes its page again, open the site,
// watch the Network tab for the POST request to "/", and update this value
// (and the tt token logic below) to match what the browser actually sends.
const CURRENT_URL = 'https://ssstwitter.com/en-2';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function extractTweetUrl(text) {
    const match = text.match(
        /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+/i
    );

    return match ? match[0].replace(/[),.!?]+$/, '') : null;
}

// ssstwitter's own frontend stamps every submission with a short-lived "tt"
// token derived from the current unix timestamp. This reproduces it.
function buildToken(timestampSeconds) {
    return crypto
        .createHash('md5')
        .update(`${timestampSeconds}ssstwitter`)
        .digest('hex');
}

function parseDownloads(html) {
    const $ = cheerio.load(html);
    const seen = new Set();
    const downloads = [];

    $('.download-btn, a[href*=".mp4"], a[href*="video.twimg.com"]').each(
        (_, el) => {
            const href = $(el).attr('href');

            if (!href || !/^https?:\/\//i.test(href) || seen.has(href)) {
                return;
            }

            seen.add(href);

            const label = $(el)
                .text()
                .replace(/\s+/g, ' ')
                .replace(/^download\s*/i, '')
                .trim();

            downloads.push({
                quality: label || 'Video',
                url: href,
            });
        }
    );

    if (downloads.length) {
        return downloads;
    }

    // Fallback for whenever ssstwitter tweaks its markup again: pull raw
    // .mp4 links straight out of the response instead of relying on class
    // names that can change at any time. The backslash-? before each slash
    // handles links embedded in JSON/script blobs (e.g. "https:\/\/...")
    // as well as plain HTML.
    const mp4Pattern =
        /https?:\\?\/\\?\/[^"'\s<>]+?\.mp4(?:\?[^"'\s<>]*)?/gi;
    let match;

    while ((match = mp4Pattern.exec(html)) !== null) {
        const link = match[0]
            .replace(/\\\//g, '/')
            .replace(/\\u0026/g, '&')
            .replace(/[\\]+$/g, '');

        if (!seen.has(link)) {
            seen.add(link);
            downloads.push({ quality: 'Video', url: link });
        }
    }

    return downloads;
}

async function getVideo(tweetUrl) {
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = new URLSearchParams({
        id: tweetUrl,
        locale: 'en',
        tt: buildToken(timestamp),
        ts: String(timestamp),
        source: 'form',
    });

    const response = await axios.post(BASE_URL, payload.toString(), {
        timeout: 30000,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            'HX-Request': 'true',
            'HX-Target': 'target',
            'HX-Current-URL': CURRENT_URL,
            Origin: 'https://ssstwitter.com',
            Referer: CURRENT_URL,
        },
    });

    const html =
        typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data);

    if (/just a moment|cf-chl|attention required/i.test(html)) {
        throw new Error(
            'SSSTwitter returned a security check instead of a result. This can happen when requests come from a flagged server IP — try again shortly.'
        );
    }

    const downloads = parseDownloads(html);

    if (!downloads.length) {
        throw new Error(
            'SSSTwitter did not return a downloadable MP4 link. The post may have no video, be private, or SSSTwitter changed its page again.'
        );
    }

    return downloads.find((d) => /\bhd\b/i.test(d.quality)) || downloads[0];
}

module.exports = {
    command: 'x',
    aliases: ['twitter', 'twitterdl'],
    description: 'Download public Twitter/X videos using SSSTwitter',
    category: 'downloader',

    async execute(sock, msg, args) {
        const jid = msg.key.remoteJid;

        const input = Array.isArray(args)
            ? args.join(' ')
            : String(args || '');

        const tweetUrl = extractTweetUrl(input);

        if (!tweetUrl) {
            return sock.sendMessage(
                jid,
                {
                    text: 'Please provide a valid X/Twitter post link.\n\nExample: .x https://x.com/user/status/123456789',
                },
                { quoted: msg }
            );
        }

        await sock.sendMessage(
            jid,
            { text: 'Downloading Twitter video...' },
            { quoted: msg }
        );

        try {
            const video = await getVideo(tweetUrl);

            await sock.sendMessage(
                jid,
                {
                    video: { url: video.url },
                    mimetype: 'video/mp4',
                    caption: `Downloaded from SSSTwitter (${video.quality}).`,
                },
                { quoted: msg }
            );
        } catch (error) {
            console.error('[SSSTWITTER ERROR]', error?.message || error);

            await sock.sendMessage(
                jid,
                {
                    text:
                        'Failed to download this video.\n\n' +
                        'Possible reasons:\n' +
                        '- The post does not contain a video.\n' +
                        '- The post is private or unavailable.\n' +
                        '- SSSTwitter changed its page again.\n\n' +
                        'Try again later.',
                },
                { quoted: msg }
            );
        }
    },
};
