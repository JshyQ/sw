const FileType = require('file-type');
const { postStory, remuxVideo, compressVideo, enhanceVideo, audienceSize } = require('./story');

const IMAGE_OK = ['image/jpeg', 'image/png', 'image/webp'];
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const isMediaMime = (t) => /^(image|video)\//.test(t || '');

// forceCompress: true = always re-encode video (smaller file, same resolution)
//                false = never re-encode (original quality, just remux container if needed)
const handleStoryUpload = async (sock, m, { quoted, mime, text, reply, prefix, config }, forceCompress) => {
    const cmd = forceCompress ? 'swc' : 'sw';
    const mtype = quoted.mtype;
    const isDoc = mtype === 'documentMessage';
    const declared = isMediaMime(mime);

    // Documents are accepted even if WhatsApp labels them wrongly (no/odd extension):
    // the real type is detected from the file content below.
    if (!['imageMessage', 'videoMessage', 'documentMessage'].includes(mtype) || (!declared && !isDoc)) {
        return reply(
            `*Post to story (${forceCompress ? 'compressed video' : 'HD video, same file size'})*\n\n` +
            `1. Send the photo/video as a *Document* (attach > Document) with caption ${prefix}${cmd}\n` +
            `   or reply to it with ${prefix}${cmd}\n` +
            `2. Optional caption: ${prefix}${cmd} your caption\n\n` +
            `Normal photos/videos are already compressed by WhatsApp before they reach the bot. ` +
            `Documents keep the original file.\n\n` +
            `${forceCompress ? `${prefix}sw` : `${prefix}swc`} is also available if you want ${forceCompress ? 'the HD, same-size' : 'a compressed'} video instead.\n\n` +
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

        // Videos are posted as ONE file: full length, original resolution (never scaled or split).
        // forceCompress decides whether it gets re-encoded to a much smaller mp4 (.swc) or
        // kept at original quality, only remuxed to mp4 if needed (.sw).
        let out = buffer;
        let outMime = mimetype;
        let hdInfo = null;
        if (isVideo) {
            const c = config.story?.compress || {};
            try {
                if (forceCompress) {
                    await reply(`Compressing video (${mb(buffer.length)}), same resolution. This can take several minutes...`);
                    const small = await compressVideo(buffer, c);
                    if (small.length < buffer.length || mimetype !== 'video/mp4') {
                        out = small;
                        outMime = 'video/mp4';
                    } // else: already smaller than the re-encode, keep the original
                } else {
                    // .sw: upscale to HD at the same file size (skipped if already HD or disabled)
                    const hdCfg = config.story?.hd || {};
                    let hd = null;
                    if (hdCfg.enabled !== false) {
                        await reply(`Upgrading video to HD (${mb(buffer.length)}, keeping the file size). This can take a few minutes...`);
                        hd = await enhanceVideo(buffer, hdCfg);
                    }
                    if (hd) {
                        out = hd.buffer;
                        outMime = 'video/mp4';
                        hdInfo = `HD ${hd.from} -> ${hd.width}x${hd.height}`;
                    } else if (mimetype !== 'video/mp4') {
                        await reply(`Converting ${mimetype.split('/')[1]} to mp4 (no re-encode)...`);
                        out = await remuxVideo(buffer);
                        outMime = 'video/mp4';
                    }
                }
            } catch (e) {
                console.log(e);
                return reply(`Could not process the video. Nothing was posted.\nReason: ${e.message || e}`);
            }
        }

        await reply(`Uploading to story (${mb(out.length)}${out !== buffer ? `, was ${mb(buffer.length)}` : ''})...`);
        const { recipients } = await postStory(sock, { buffer: out, mimetype: outMime, caption: text });

        await reply(`Story posted (${isVideo ? 'video, full length' : 'image'}, ${mb(out.length)}, ${hdInfo || (out !== buffer ? 'compressed, same resolution' : 'original')}, ${recipients} recipients)`);
    } catch (e) {
        console.log(e);
        await reply(`Failed: ${e.message || e}`);
    }
};

module.exports = { handleStoryUpload };
