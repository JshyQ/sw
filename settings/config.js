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
        description: "this script was created by Debraj",
        author: 'https://www.github.com/OfficialKango',
        footer: "饾棈饾柧饾梾饾柧饾梹饾棆饾柡饾梿: @official_kango"
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
            maxFps: 0        // 0 = keep original fps; e.g. 60 to cap 120fps videos (much smaller)
        },
        ffmpegPath: '', // optional: full path to your ffmpeg binary (leave empty to auto-detect)
        videoSegmentSeconds: 30, // videos longer than this are split into consecutive story parts (raise to 60/90 if your WhatsApp allows it)
        includeChatPartners: false // true = also show stories to people you chat with (not only contacts)
    },
    sticker: {
        packname: "Simple WA Base Bot",
        author: "WA-BASE"
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
