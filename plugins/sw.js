const FileType = require('file-type');
const { postStory, remuxVideo, audienceSize } = require('../library/story');

const IMAGE_OK = ['image/jpeg', 'image/png', 'image/webp'];
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const isMediaMime = (t) => /^(image|video)\//.test(t || '');

module.exports = {
    command: 'sw',
    description: 'Post image/video to your story in original quality',
    category: 'story',
    owner: true,
    execute: async (sock, m, { quoted, mime, text, reply, prefix, config }) => {
        const mtype = quoted.mtype;
        const isDoc = mtype === 'documentMessage';
        const declared = isMediaMime(mime);

        // Documents are accepted even if WhatsApp labels them wrongly (no/odd extension):
        // the real type is detected from the file content below.
        if (!['imageMessage', 'videoMessage', 'documentMessage'].includes(mtype) || (!declared && !isDoc)) {
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

        const mediaMsg = quoted.msg || quoted;
        await reply('Downloading...');

        try {
            // Download original bytes. Type must match the message type (document != image).
            const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(mediaMsg, mtype.replace('Message', ''));

            const chunks = [];
            let size = 0;
            let mimetype = mime;
            let checked = declared; // only sniff when the declared type isn't image/video
            let rejected = null;

            for await (const chunk of stream) {
                chunks.push(chunk);
                size += chunk.length;
                if (!checked && size >= 4100) {
                    checked = true;
                    const t = await FileType.fromBuffer(Buffer.concat(chunks));
                    if (!t || !isMediaMime(t.mime)) { rejected = t ? t.mime : 'unknown'; break; } // stop early, don't pull 200MB of a PDF
                    mimetype = t.mime;
                }
            }
            if (rejected) return reply(`That file is not an image/video (detected: ${rejected}).`);

            const buffer = Buffer.concat(chunks);
            if (!checked) { // tiny file, sniff whole thing
                const t = await FileType.fromBuffer(buffer);
                if (!t || !isMediaMime(t.mime)) return reply('That file is not an image/video.');
                mimetype = t.mime;
            }

            const isVideo = /^video\//.test(mimetype);
            if (!isVideo && !IMAGE_OK.includes(mimetype)) {
                return reply(`Unsupported image type (${mimetype}). Use JPG, PNG or WEBP.`);
            }

            // Videos are posted as ONE file: full length, original resolution, never split or re-encoded.
            // Only non-mp4 containers (mov, mkv...) are rewrapped into mp4 (stream copy, no quality loss).
            let out = buffer;
            let outMime = mimetype;
            if (isVideo && mimetype !== 'video/mp4') {
                await reply(`Converting ${mimetype.split('/')[1]} to mp4 (no re-encode, ${mb(buffer.length)})...`);
                try {
                    out = await remuxVideo(buffer);
                    outMime = 'video/mp4';
                } catch (e) {
                    console.log(e);
                    return reply(`Could not convert the video. Nothing was posted.\nReason: ${e.message || e}`);
                }
            }

            await reply(`Uploading to story (${mb(out.length)})...`);
            const { recipients } = await postStory(sock, { buffer: out, mimetype: outMime, caption: text });

            await reply(`Story posted (${isVideo ? 'video, full length' : 'image'}, ${mb(out.length)}, original quality, ${recipients} recipients)`);
        } catch (e) {
            console.log(e);
            await reply(`Failed: ${e.message || e}`);
        }
    }
};
