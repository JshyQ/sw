const FileType = require('file-type');
const { postStory, remuxVideo, compressVideo, enhanceVideo, audienceSize } = require('./story');

const IMAGE_OK = ['image/jpeg', 'image/png', 'image/webp'];
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const isMediaMime = (t) => /^(image|video)\//.test(t || '');

// mode: 'original' (.sw)   = never re-encode, same resolution (only remux container if needed)
//       'hd'       (.swhd) = upscale to HD, file size kept about the same
//       'compress' (.swc)  = re-encode to a smaller file, same resolution
const MODES = {
    original: { cmd: 'sw', label: 'original quality' },
    hd: { cmd: 'swhd', label: 'HD upscale, same file size' },
    compress: { cmd: 'swc', label: 'compressed video' }
};

const handleStoryUpload = async (sock, m, { quoted, mime, text, reply, prefix, config }, mode = 'original') => {
    const { cmd, label } = MODES[mode] || MODES.original;
    const others = Object.entries(MODES).filter(([k]) => k !== mode).map(([, v]) => `${prefix}${v.cmd} (${v.label})`).join('\n   ');
    const mtype = quoted.mtype;
    const isDoc = mtype === 'documentMessage';
    const declared = isMediaMime(mime);

    // Documents are accepted even if WhatsApp labels them wrongly (no/odd extension):
    // the real type is detected from the file content below.
    if (!['imageMessage', 'videoMessage', 'documentMessage'].includes(mtype) || (!declared && !isDoc)) {
        return reply(
            `*Post to story (${label})*\n\n` +
            `1. Send the photo/video as a *Document* (attach > Document) with caption ${prefix}${cmd}\n` +
            `   or reply to it with ${prefix}${cmd}\n` +
            `2. Optional caption: ${prefix}${cmd} your caption\n\n` +
            `Normal photos/videos are already compressed by WhatsApp before they reach the bot. ` +
            `Documents keep the original file.\n\n` +
            `Other commands:\n   ${others}\n\n` +
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

        // Videos are posted as ONE file, full length (never split).
        // .sw = untouched (remux only), .swhd = upscaled to HD at the same file size,
        // .swc = re-encoded to a smaller file at the same resolution.
        let out = buffer;
        let outMime = mimetype;
        let hdInfo = null;
        if (isVideo) {
            const c = config.story?.compress || {};
            try {
                if (mode === 'compress') {
                    await reply(`Compressing video (${mb(buffer.length)}), same resolution. This can take several minutes...`);
                    const small = await compressVideo(buffer, c);
                    if (small.length < buffer.length || mimetype !== 'video/mp4') {
                        out = small;
                        outMime = 'video/mp4';
                    } // else: already smaller than the re-encode, keep the original
                } else if (mode === 'hd') {
                    // .swhd: upscale to HD at the same file size (skipped if already HD)
                    await reply(`Upgrading video to HD (${mb(buffer.length)}, keeping the file size). This can take a few minutes...`);
                    const hd = await enhanceVideo(buffer, config.story?.hd || {});
                    if (hd) {
                        out = hd.buffer;
                        outMime = 'video/mp4';
                        hdInfo = `HD ${hd.from} -> ${hd.width}x${hd.height}`;
                    } else {
                        hdInfo = 'already HD, posted as is';
                        if (mimetype !== 'video/mp4') {
                            out = await remuxVideo(buffer);
                            outMime = 'video/mp4';
                        }
                    }
                } else if (mimetype !== 'video/mp4') {
                    await reply(`Converting ${mimetype.split('/')[1]} to mp4 (no re-encode)...`);
                    out = await remuxVideo(buffer);
                    outMime = 'video/mp4';
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
