// 漏 2025 Debraj. All Rights Reserved.
// respect the work, don鈥檛 just copy-paste.

const fs = require('fs')

const config = {
    owner: "6285111606001",
    botNumber: "-",
    setPair: "K0MRAID1",
    thumbUrl: "https://imgur.com/a/zHQF5Ol.jpeg",
    session: "sessions",
    status: {
        public: false,
        terminal: true,
        reactsw: false
    },
    message: {
        owner: "no, this is for owners only",
        group: "this is for groups only",
        admin: "this command is for admin only",
        private: "this is specifically for private chat"
    },
    mess: {
        owner: 'This command is only for the bot owner!',
        done: 'Mode changed successfully!',
        error: 'Something went wrong!',
        wait: 'Please wait...'
    },
    settings: {
        title: "Simple WA Base Bot",
        packname: 'WA-BASE',
        description: "this script was created by JoQ",
        author: 'JoQ',
        footer: "CATS!"
    },
    newsletter: {
        name: "Simple WA Base Bot",
        id: "0@newsletter"
    },
    api: {
        baseurl: "https://hector-api.vercel.app/",
        apikey: "hector"
    },
    story: {
        compress: {
            enabled: true,   // re-encode videos to a smaller file (resolution and length are never changed)
            crf: 32,         // higher = smaller file, lower quality (26 = good, 32 = small, 36 = very small)
            preset: 'medium', // slower = smaller file (fast, medium, slow, slower)
            audioKbps: 96,
            maxFps: 60        // 0 = keep original fps; e.g. 60 to cap 120fps videos (much smaller)
        },
        hd: { // used by .swhd (upscale to HD, file size kept about the same)
            targetShortSide: 1080, // short side in pixels (1080 = Full HD, 720 = HD). Videos already this size or bigger are left untouched
            preset: 'slow',       // slower = better quality per MB (veryfast, medium, slow, slower)
            sharpen: 0.6,         // 0 = off, 0.3-1.0 = light to strong sharpening after upscaling
            denoise: true,        // remove noise first so the bitrate is spent on real detail
            audioKbps: 128,
            maxFps: 60,           // 0 = keep original fps
            twoPass: true,        // more accurate file size, takes about twice as long
            sizeTolerance: 1.08   // if the result is bigger than original x this, the original is posted instead
        },
        ffmpegPath: '', // optional: full path to your ffmpeg binary (leave empty to auto-detect)
        videoSegmentSeconds: 30, // videos longer than this are split into consecutive story parts (raise to 60/90 if your WhatsApp allows it)
        includeChatPartners: false // true = also show stories to people you chat with (not only contacts)
    },
    sticker: {
        packname: "Joshy",
        author: "JoQ"
    }
}

module.exports = config;

let file = require.resolve(__filename)
require('fs').watchFile(file, () => {
  require('fs').unwatchFile(file)
  console.log('\x1b[0;32m'+__filename+' \x1b[1;32mupdated!\x1b[0m')
  delete require.cache[file]
  require(file)
})
