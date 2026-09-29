const { postStory, audienceSize } = require('../library/story');

const IMAGE_OK = ['image/jpeg', 'image/png', 'image/webp'];
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

module.exports = {
    command: 'sw',
    description: 'Post image/video to your story in original quality',
    category: 'story',
    owner: true,
    execute: async (sock, m, { quoted, mime, text, reply, prefix }) => {
        const isImage = /^image\//.test(mime);
        const isVideo = /^video\//.test(mime);

        if (!isImage && !isVideo) {
            return reply(
                `*Post to story (original quality)*\n\n` +
                `1. Send the photo/video as a *Document* (attach > Document) with caption ${prefix}sw\n` +
                `   or reply to it with ${prefix}sw\n` +
                `2. Optional caption: ${prefix}sw your caption\n\n` +
                `Normal photos/videos are already compressed by WhatsApp before they reach the bot. ` +
                `Documents keep the original file.\n\n` +
                `Story audience: ${audienceSize()} contacts (+ you)`
            );
        }

        if (isImage && !IMAGE_OK.includes(mime)) {
            return reply(`Unsupported image type (${mime}). Use JPG, PNG or WEBP.`);
        }

        // Which message holds the media: the replied one, or the command message itself
        const mtype = quoted.mtype;
        if (!['imageMessage', 'videoMessage', 'documentMessage'].includes(mtype)) {
            return reply('Could not read that media type.');
        }
        const mediaMsg = quoted.msg || quoted;

        await reply('Uploading to story...');

        // Download original bytes. Type must match the message type (document != image).
        const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
        const stream = await downloadContentFromMessage(mediaMsg, mtype.replace('Message', ''));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        const { recipients } = await postStory(sock, { buffer, mimetype: mime, caption: text });

        await reply(`Story posted (${isVideo ? 'video' : 'image'}, original ${mb(buffer.length)}, ${recipients} recipients)`);
    }
};
