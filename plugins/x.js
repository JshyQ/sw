const axios = require('axios');

const BASE_URL = 'https://ssstwitter.com/';

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

function extractTweetUrl(text) {
    const match = text.match(
        /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+/i
    );

    return match ? match[0].replace(/[),.!?]+$/, '') : null;
}

function decodeHtml(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&#38;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function extractVideoLinks(html) {
    const links = new Set();

    const patterns = [
        /https?:\\?\/\\?\/[^"'\\\s<>]+?\.mp4(?:\?[^"'\\\s<>]*)?/gi,
        /https?:\/\/[^"'\\\s<>]+?\.mp4(?:\?[^"'\\\s<>]*)?/gi,
        /https?:\/\/ssscdn\.io\/[^"'\\\s<>]+/gi,
    ];

    for (const pattern of patterns) {
        const matches = html.match(pattern) || [];

        for (let link of matches) {
            link = link
                .replace(/\\\//g, '/')
                .replace(/\\u0026/g, '&')
                .replace(/\\u003d/g, '=')
                .replace(/&amp;/g, '&')
                .replace(/[\\]+$/g, '');

            link = decodeHtml(link);

            if (
                /^https?:\/\//i.test(link) &&
                (link.includes('.mp4') || link.includes('ssscdn.io'))
            ) {
                links.add(link);
            }
        }
    }

    // Also inspect ordinary HTML download links.
    const anchorRegex =
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = anchorRegex.exec(html)) !== null) {
        const href = decodeHtml(match[1]);
        const content = match[2];

        if (
            /^https?:\/\//i.test(href) &&
            (
                /\.mp4(?:\?|$)/i.test(href) ||
                /ssscdn\.io/i.test(href) ||
                /download|video|mp4/i.test(content)
            )
        ) {
            links.add(href);
        }
    }

    return [...links];
}

async function getVideo(tweetUrl) {
    const client = axios.create({
        timeout: 30000,
        maxRedirects: 5,
        headers: HEADERS,
    });

    // Load SSSTwitter's homepage.
    const homepage = await client.get(BASE_URL);
    const html = homepage.data;

    // Find the form that accepts the tweet URL.
    const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) || [];

    let selectedForm = null;

    for (const form of forms) {
        if (
            /url|tweet|twitter|link/i.test(form) &&
            /input/i.test(form)
        ) {
            selectedForm = form;
            break;
        }
    }

    if (!selectedForm) {
        throw new Error(
            'Could not find the SSSTwitter download form.'
        );
    }

    // Read form action and method.
    const actionMatch = selectedForm.match(
        /\baction=["']([^"']*)["']/i
    );

    const methodMatch = selectedForm.match(
        /\bmethod=["']([^"']*)["']/i
    );

    const action = actionMatch
        ? new URL(actionMatch[1], BASE_URL).href
        : BASE_URL;

    const method = methodMatch
        ? methodMatch[1].toUpperCase()
        : 'POST';

    // Collect form inputs, including hidden fields.
    const data = new URLSearchParams();

    const inputRegex = /<input\b[^>]*>/gi;
    let input;

    let urlField = null;

    while ((input = inputRegex.exec(selectedForm)) !== null) {
        const tag = input[0];

        const nameMatch = tag.match(
            /\bname=["']([^"']+)["']/i
        );

        const valueMatch = tag.match(
            /\bvalue=["']([^"']*)["']/i
        );

        if (!nameMatch) continue;

        const name = nameMatch[1];
        const value = valueMatch ? valueMatch[1] : '';

        if (/url|tweet|twitter|link/i.test(name)) {
            urlField = name;
        }

        if (/hidden/i.test(tag)) {
            data.append(name, value);
        }
    }

    // Find a URL field from the form's textarea if necessary.
    if (!urlField) {
        const textareaMatch = selectedForm.match(
            /<textarea\b[^>]*name=["']([^"']+)["']/i
        );

        if (textareaMatch) {
            urlField = textareaMatch[1];
        }
    }

    if (!urlField) {
        throw new Error(
            'Could not identify SSSTwitter URL input.'
        );
    }

    data.set(urlField, tweetUrl);

    const requestHeaders = {
        ...HEADERS,
        Referer: BASE_URL,
        Origin: new URL(BASE_URL).origin,
        'Content-Type': 'application/x-www-form-urlencoded',
    };

    // Submit the tweet URL.
    const response = method === 'GET'
        ? await client.get(action, {
            params: Object.fromEntries(data.entries()),
            headers: requestHeaders,
        })
        : await client.post(action, data.toString(), {
            headers: requestHeaders,
        });

    const resultHtml =
        typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data);

    const videos = extractVideoLinks(resultHtml);

    if (!videos.length) {
        throw new Error(
            'SSSTwitter did not return a downloadable MP4 link. The website may have changed its form or require JavaScript.'
        );
    }

    return videos[0];
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
            {
                text: 'Downloading Twitter video...',
            },
            { quoted: msg }
        );

        try {
            const videoUrl = await getVideo(tweetUrl);

            await sock.sendMessage(
                jid,
                {
                    video: { url: videoUrl },
                    mimetype: 'video/mp4',
                    caption: 'Downloaded from SSSTwitter.',
                },
                { quoted: msg }
            );
        } catch (error) {
            console.error('[SSSTWITTER ERROR]', error);

            await sock.sendMessage(
                jid,
                {
                    text:
                        'Failed to download this video.\n\n' +
                        'Possible reasons:\n' +
                        '- The post does not contain a video.\n' +
                        '- The post is private or unavailable.\n' +
                        '- SSSTwitter changed its download form or requires JavaScript.\n\n' +
                        'Try again later.',
                },
                { quoted: msg }
            );
        }
    },
};
