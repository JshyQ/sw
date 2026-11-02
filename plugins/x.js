const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Downloads Twitter/X media using twittervideodownloader.com/en/
 * @param {string} tweetUrl - The public URL of the tweet.
 * @returns {Promise<Object>} - Result object containing download links and qualities.
 */
async function downloadTwitterVideo(tweetUrl) {
    try {
        const targetUrl = 'https://twittervideodownloader.com/en/';

        // Submit the tweet URL via form-urlencoded payload
        const response = await axios.post(targetUrl, new URLSearchParams({
            url: tweetUrl
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': targetUrl,
                'Origin': 'https://twittervideodownloader.com'
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const mediaItems = [];

        // Parse download links from the resulting page markup
        $('a.button, a.download-link, .download-box a, a[href*=".mp4"]').each((_, element) => {
            const link = $(element).attr('href');
            const qualityText = $(element).text().trim() || 'Standard MP4';
            
            if (link && (link.startsWith('http') || link.startsWith('https'))) {
                // Avoid capturing duplicate navigation/footer links
                if (!mediaItems.some(item => item.url === link)) {
                    mediaItems.push({
                        quality: qualityText.replace(/\s+/g, ' '),
                        url: link
                    });
                }
            }
        });

        if (mediaItems.length === 0) {
            throw new Error('No downloadable media streams found for this tweet.');
        }

        return {
            status: true,
            source: 'twittervideodownloader.com',
            tweetUrl,
            results: mediaItems
        };

    } catch (error) {
        return {
            status: false,
            error: error.message || 'Failed to process tweet download.'
        };
    }
}

// Optional: Command handler wrapper if integrated into a bot plugin
async function handleCommand(m, sock, args) {
    const tweetUrl = args[0];
    if (!tweetUrl || !tweetUrl.includes('twitter.com') && !tweetUrl.includes('x.com')) {
        return m.reply('❌ Please provide a valid Twitter/X post URL.');
    }

    await m.reply('⏳ Fetching video from TwitterVideoDownloader...');
    const res = await downloadTwitterVideo(tweetUrl);

    if (!res.status || res.results.length === 0) {
        return m.reply(`❌ Error: ${res.error || 'Could not retrieve video.'}`);
    }

    // Send the highest quality link or list available links
    const bestMedia = res.results[0];
    await sock.sendMessage(m.chat, {
        video: { url: bestMedia.url },
        caption: `✅ Downloaded via TwitterVideoDownloader\nQuality: ${bestMedia.quality}`
    }, { quoted: m });
}

module.exports = {
    downloadTwitterVideo,
    handleCommand
};
