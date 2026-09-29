const FileType = require('file-type');
const { postStory, splitVideo, audienceSize } = require('../library/story');

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

            // Videos: keep the full duration. If longer than one story allows, post it as consecutive parts.
            // Non-mp4 containers (mov, mkv...) are remuxed to mp4 (stream copy, no quality loss).
            let parts = [buffer];
            let partMime = mimetype;
            if (isVideo) {
                const limit = config.story?.videoSegmentSeconds || 30;
                const seconds = Number(mediaMsg.seconds) || 0; // unknown for documents
                const needRemux = mimetype !== 'video/mp4';
                if (needRemux || !seconds || seconds > limit) {
                    await reply(`Processing video (${mb(buffer.length)})...`);
                    try {
                        const split = await splitVideo(buffer, limit);
                        if (split.length > 1 || needRemux) { parts = split; partMime = 'video/mp4'; }
                    } catch (e) {
                        console.log(e);
                        return reply('Could not process the video (is ffmpeg installed?). Nothing was posted.');
                    }
                }
            }

            await reply(`Uploading ${parts.length} ${parts.length > 1 ? 'parts' : 'file'} to story...`);
            let recipients = 0;
            for (let i = 0; i < parts.length; i++) {
                ({ recipients } = await postStory(sock, {
                    buffer: parts[i],
                    mimetype: partMime,
                    caption: i === 0 ? text : ''
                }));
                if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 1500)); // keep order
            }

            await reply(
                `Story posted (${isVideo ? 'video' : 'image'}, ${mb(buffer.length)}` +
                `${parts.length > 1 ? `, ${parts.length} parts, full length kept` : ', original'}, ${recipients} recipients)`
            );
        } catch (e) {
            console.log(e);
            await reply(`Failed: ${e.message || e}`);
        }
    }
};
