const axios = require("axios");

module.exports = {
  name: "r34",
  alias: ["rule34"],
  desc: "Get random Rule34 images by tags",
  category: "Nsfw",
  usage: `.r34 <tags>`,
  react: "🔞",

  start: async (Yaka, m, { prefix, NSFWstatus, text }) => {
    if (NSFWstatus == "false") {
      return m.reply(`This group is not NSFW enabled!\n\nUse: *${prefix}nsfw*`);
    }

    if (!text) {
      return m.reply(`Usage: *${prefix}r34 <tags>*\nExample: *${prefix}r34 catgirl*`);
    }

    try {
      m.reply(mess.waiting);
      
      const tags = text.trim().replace(/\s+/g, "_");
      const apiUrl = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(tags)}&json=1&limit=100`;
      
      const response = await axios.get(apiUrl, { timeout: 10000 });
      
      if (!response.data || response.data.length === 0) {
        return m.reply(`No results for: *${text}*`);
      }

      const randomPost = response.data[Math.floor(Math.random() * response.data.length)];
      const mediaUrl = randomPost.file_url;
      const isVideo = mediaUrl.endsWith('.mp4') || mediaUrl.endsWith('.webm');

      if (isVideo) {
        await Yaka.sendMessage(m.from, {
          video: { url: mediaUrl },
          caption: `🔞 *Rule34*\n\nTags: ${text}\nScore: ${randomPost.score}`
        }, { quoted: m });
      } else {
        await Yaka.sendMessage(m.from, {
          image: { url: mediaUrl },
          caption: `🔞 *Rule34*\n\nTags: ${text}\nScore: ${randomPost.score}`
        }, { quoted: m });
      }

    } catch (error) {
      m.reply(`Error: ${error.message}`);
    }
  },
};