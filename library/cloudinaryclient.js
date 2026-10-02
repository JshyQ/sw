const cloudinary = require('cloudinary').v2;

let configured = false;
const getCloudinary = () => {
    if (configured) return cloudinary;
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
        throw new Error(
            'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and ' +
            'CLOUDINARY_API_SECRET (e.g. in a .env file) before using a cloudinary provider.'
        );
    }
    cloudinary.config({
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET,
        secure: true
    });
    configured = true;
    return cloudinary;
};

module.exports = { getCloudinary };
