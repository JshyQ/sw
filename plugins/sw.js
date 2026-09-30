const { handleStoryUpload } = require('../library/storyUpload');

module.exports = {
    command: 'sw',
    description: 'Post image/video to your story, original quality and resolution (no upscale)',
    category: 'story',
    owner: true,
    execute: async (sock, m, ctx) => handleStoryUpload(sock, m, ctx, 'original')
};
