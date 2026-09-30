const { handleStoryUpload } = require('../library/storyUpload');

module.exports = {
    command: 'swhd',
    description: 'Post image/video to your story, video upscaled to HD at the same file size',
    category: 'story',
    owner: true,
    execute: async (sock, m, ctx) => handleStoryUpload(sock, m, ctx, 'hd')
};
