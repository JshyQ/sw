
const axios = require('axios');

const BASE_URL = 'https://twittervideodownloader.com';
const PAGE_URL = `${BASE_URL}/en/`;

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Decode HTML entities
function decodeHTML(str = '') {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x2F;/gi, '/')
        .replace(/&#(\d+);/g, (_, n) =>
            String.fromCodePoint(Number(n))
        )
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
            String.fromCodePoint(parseInt(n, 16))
        );
}

// Extract HTML attributes
function getAttribute(html, name) {
    const regex = new RegExp(
        `${name}\\s*=\\s*["']([^"']*)["']`,
        'i'
    );

    return html.match(regex)?.[1] || '';
}

// Validate Twitter/X URL
function validateTweetURL(tweetUrl) {
    try {
        const url = new URL(tweetUrl);

        const allowedHosts = [
            'twitter.com',
            'www.twitter.com',
            'mobile.twitter.com',
            'x.com',
            'www.x.com'
        ];

        if (!['http:', 'https:'].includes(url.protocol)) {
            return false;
        }

        if (!allowedHosts.includes(url.hostname.toLowerCase())) {
            return false;
        }

        return /\/status\/\d+/.test(url.pathname);
    } catch {
        return false;
    }
}

// Extract video links from the returned HTML
function extractVideos(html) {
    const results = [];

    const anchorRegex = /<a\b[^>]*>[\s\S]*?<\/a>/gi;

    let match;

    while ((match = anchorRegex.exec(html)) !== null) {
        const anchor = match[0];

        const href = getAttribute(anchor, 'href');

        if (!href) continue;

        let videoURL;

        try {
            videoURL = new URL(decodeHTML(href), BASE_URL);
        } catch {
            continue;
        }

        if (!['http:', 'https:'].includes(videoURL.protocol)) {
            continue;
        }

        const label = decodeHTML(
            anchor
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        );

        const isTwitterCDN =
            videoURL.hostname === 'video.twimg.com';

        const isDownloadLink =
            /download\s*(video|mp4)?/i.test(label);

        if (!isTwitterCDN && !isDownloadLink) {
            continue;
        }

        if (
            videoURL.hostname === 'twittervideodownloader.com' ||
            videoURL.hostname.endsWith('.twittervideodownloader.com')
        ) {
            continue;
        }

        if (!results.some(item => item.url === videoURL.href)) {
            results.push({
                quality: label || 'Twitter Video',
                url: videoURL.href
            });
        }
    }

    // Prefer higher resolutions when quality labels contain them
    results.sort((a, b) => {
        const getResolution = item =>
            Number(item.quality.match(/(\d{3,4})p/i)?.[1] || 0);

        return getResolution(b) - getResolution(a);
    });

    return results;
}

// Download Twitter video through TwitterVideoDownloader
async function downloadTwitterVideo(tweetUrl) {
    try {
        if (!validateTweetURL(tweetUrl)) {
            throw new Error('Invalid Twitter/X post URL.');
        }

        const session = axios.create({
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        // STEP 1: Open downloader website
        const page = await session.get(PAGE_URL);

        const html = page.data;

        // Get cookies
        const cookies = page.headers['set-cookie'] || [];

        const cookieString = cookies
            .map(cookie => cookie.split(';')[0])
            .join('; ');

        // Get CSRF token
        const csrfCookie = cookies.find(cookie =>
            cookie.startsWith('csrftoken=')
        );

        const csrfToken = csrfCookie
            ? csrfCookie.split(';')[0].split('=').slice(1).join('=')
            : '';

        // STEP 2: Find the website's download form
        const formMatch = html.match(
            /<form\b[^>]*>[\s\S]*?<\/form>/i
        );

        const formHTML = formMatch ? formMatch[0] : '';

        const openingForm = formHTML.match(/<form\b[^>]*>/i)?.[0] || '';

        let action = getAttribute(openingForm, 'action');

        // Historical downloader endpoint fallback
        if (!action) {
            action = '/download';
        }

        const submitURL = new URL(action, PAGE_URL).href;

        // Find the tweet input field
        const inputMatches = formHTML.match(/<input\b[^>]*>/gi) || [];

        let tweetField = 'tweet';

        for (const input of inputMatches) {
            const name = getAttribute(input, 'name');
            const type = getAttribute(input, 'type');

            if (
                name &&
                ['text', 'url', 'search'].includes(type.toLowerCase()) &&
                !/csrf/i.test(name)
            ) {
                tweetField = name;
                break;
            }
        }

        // STEP 3: Prepare form data
        const formData = new URLSearchParams();

        formData.append(tweetField, tweetUrl);

        // Preserve hidden form fields
        for (const input of inputMatches) {
            const name = getAttribute(input, 'name');
            const value = getAttribute(input, 'value');
            const type = getAttribute(input, 'type');

            if (
                name &&
                type.toLowerCase() === 'hidden' &&
                name !== tweetField
            ) {
                formData.append(name, value);
            }
        }

        if (
            csrfToken &&
            !formData.has('csrfmiddlewaretoken')
        ) {
            formData.append('csrfmiddlewaretoken', csrfToken);
        }

        // STEP 4: Submit tweet URL
        const response = await session.post(
            submitURL,
            formData.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': USER_AGENT,
                    'Referer': PAGE_URL,
                    'Origin': BASE_URL,
                    'Cookie': cookieString,
                    ...(csrfToken
                        ? { 'X-CSRFToken': csrfToken }
                        : {})
                },
                maxRedirects: 5
            }
        );

        if (typeof response.data !== 'string') {
            throw new Error('Unexpected response from downloader website.');
        }

        // STEP 5: Extract downloadable video links
        const results = extractVideos(response.data);

        if (!results.length) {
            if (/private|protected/i.test(response.data)) {
                throw new Error(
                    'This tweet is private or protected.'
                );
            }

            if (/no video|video not found|unable to find/i.test(response.data)) {
                throw new Error(
                    'No downloadable video was found in this tweet.'
                );
            }

            throw new Error(
                'The website did not return any video links. Its form or response may have changed.'
            );
        }

        return {
            status: true,
            source: 'twittervideodownloader.com',
            tweetUrl,
            results
        };

    } catch (error) {
        console.error('[X Downloader]', error.message);

        return {
            status: false,
            error: error.response
                ? `Downloader returned HTTP ${error.response.status}.`
                : error.message || 'Failed to download Twitter video.'
        };
    }
}

// WhatsApp plugin
module.exports = {
    command: 'x',
    aliases: ['twitter', 'twitterdl'],
    description: 'Download Twitter/X videos',
    category: 'downloader',

    execute: async (sock, m, {
        args,
        text,
        reply
    }) => {
        const tweetUrl = (
            args?.[0] || text || ''
        ).trim().split(/\s+/)[0];

        if (!tweetUrl || !validateTweetURL(tweetUrl)) {
            return reply(
                '❌ Please provide a valid Twitter/X post URL.\n\n' +
                'Example:\n' +
                '.x https://x.com/user/status/123456789'
            );
        }

        await reply(
            '⏳ Fetching Twitter video...\n' +
            'Please wait.'
        );

        const result = await downloadTwitterVideo(tweetUrl);

        if (!result.status || !result.results.length) {
            return reply(
                `❌ Download failed!\n\n${result.error}`
            );
        }

        const bestVideo = result.results[0];

        try {
            await sock.sendMessage(
                m.chat,
                {
                    video: {
                        url: bestVideo.url
                    },
                    mimetype: 'video/mp4',
                    caption:
                        '✅ Twitter Video Downloaded\n\n' +
                        `📥 Source: TwitterVideoDownloader\n` +
                        `🎬 Quality: ${bestVideo.quality}`
                },
                {
                    quoted: m
                }
            );

        } catch (error) {
            console.error('[X Send Error]', error);

            await reply(
                '❌ Video was extracted, but WhatsApp failed to send it.'
            );
        }
    }
};
