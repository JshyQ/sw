// Upscale a video via Cloudinary instead of local ffmpeg.
//
// IMPORTANT: Cloudinary's AI "generative upscale" effect (e_upscale) is only documented
// for IMAGES, not video — there is no public, self-serve AI super-resolution API for video
// on Cloudinary. This does the same thing local ffmpeg already does for .swhd (lanczos
// scale + sharpen + bitrate control), just run on Cloudinary's servers instead of this
// machine's CPU. Use this if your bot's host is weak and you want to offload the work —
// not because it produces a different/better result than the local path.
//
// Needs env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

const axios = require('axios');
const { Readable } = require('stream');
const { getCloudinary } = require('./cloudinaryClient');

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// opts: targetShortSide (px), sharpen (0-1, mapped to Cloudinary's 1-2000 scale),
//       maxFps (0 = keep original), sizeTolerance (reject if result grows the file by more than this factor)
// Returns null if the video is already at/above targetShortSide (nothing to do), like enhanceVideo does.
const upscaleVideoCloud = async (buffer, opts = {}) => {
    const cloudinary = getCloudinary();
    const { targetShortSide = 1080, sharpen = 0.6, maxFps = 60, sizeTolerance = 1.08 } = opts;
    const publicId = `sw-upscale/${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Step 1: plain upload, no transformation yet — we need the original's dimensions/duration first.
    const original = await new Promise((resolve, reject) => {
        const upload = cloudinary.uploader.upload_stream(
            { resource_type: 'video', public_id: publicId, overwrite: true },
            (err, result) => (err ? reject(err) : resolve(result))
        );
        Readable.from(buffer).pipe(upload);
    });

    try {
        const { width, height, duration } = original;
        const shortSide = Math.min(width, height);
        if (shortSide >= targetShortSide) return null; // already HD, nothing to gain

        const scale = targetShortSide / shortSide;
        const outW = even(width * scale);
        const outH = even(height * scale);

        // Keep roughly the same file size as the original, same approach as the local ffmpeg path.
        const totalKbps = (buffer.length * 8 * 0.98) / Math.max(duration || 1, 1) / 1000;
        const vKbps = Math.max(300, Math.floor(totalKbps));

        // Cloudinary's e_sharpen strength is 1-2000 (default 100); map our 0-1 knob onto that range.
        const sharpenStrength = Math.round(Math.max(0, Math.min(1, sharpen)) * 400) || 1;

        const transformation = [{
            width: outW, height: outH, crop: 'scale',
            effect: sharpen > 0 ? `sharpen:${sharpenStrength}` : undefined,
            bit_rate: `${vKbps}k`,
            fetch_format: 'mp4',
            video_codec: 'auto',
            ...(maxFps > 0 ? { fps: `1-${maxFps}` } : {})
        }];

        const derived = await cloudinary.uploader.explicit(publicId, {
            resource_type: 'video',
            type: 'upload',
            eager: transformation,
            eager_async: false
        });

        const url = derived.eager?.[0]?.secure_url;
        if (!url) throw new Error('Cloudinary did not return an upscaled video');

        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000 });
        const out = Buffer.from(res.data);

        if (out.length > buffer.length * sizeTolerance) return null; // would grow the file, keep the original
        return { buffer: out, width: outW, height: outH, from: `${width}x${height}` };
    } finally {
        cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true }).catch(() => {});
    }
};

module.exports = { upscaleVideoCloud };
