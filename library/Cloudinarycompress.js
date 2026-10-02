// Compress a video via Cloudinary instead of local ffmpeg: upload the original,
// ask Cloudinary to transcode it (quality/bitrate controlled), download the result,
// then delete it from Cloudinary (we don't need it stored there).
//
// Needs env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// (put these in a local .env file — never commit real credentials to source).

const axios = require('axios');
const { Readable } = require('stream');
const { getCloudinary } = require('./cloudinaryClient');

// opts.quality: Cloudinary quality string, e.g. 'auto:good', 'auto:low', or a number 1-100.
// opts.maxFps: 0 = keep original.
const compressVideoCloud = async (buffer, opts = {}) => {
    const cloudinary = getCloudinary();
    const { quality = 'auto:good', maxFps = 0 } = opts;

    const transformation = [{
        quality,
        fetch_format: 'mp4',
        video_codec: 'auto',
        ...(maxFps > 0 ? { fps: `1-${maxFps}` } : {})
    }];

    const publicId = `sw-compress/${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const uploadResult = await new Promise((resolve, reject) => {
        const upload = cloudinary.uploader.upload_stream(
            {
                resource_type: 'video',
                public_id: publicId,
                eager: transformation,
                eager_async: false, // wait for the transcode to finish before responding
                overwrite: true
            },
            (err, result) => (err ? reject(err) : resolve(result))
        );
        Readable.from(buffer).pipe(upload);
    });

    const derived = uploadResult.eager?.[0]?.secure_url;
    if (!derived) throw new Error('Cloudinary did not return a compressed video');

    let out;
    try {
        const res = await axios.get(derived, { responseType: 'arraybuffer', timeout: 120000 });
        out = Buffer.from(res.data);
    } finally {
        // Clean up both the original upload and its eager-generated derivative.
        cloudinary.uploader.destroy(publicId, { resource_type: 'video' }).catch(() => {});
        cloudinary.uploader.destroy(publicId, { resource_type: 'video', type: 'upload', invalidate: true }).catch(() => {});
    }

    return out;
};

module.exports = { compressVideoCloud };
