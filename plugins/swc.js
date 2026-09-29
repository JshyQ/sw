const { handleStoryUpload } = require('../library/storyUpload');

module.exports = {
    command: 'swc',
    description: 'Post image/video to your story, video compressed to a smaller file',
    category: 'story',
    owner: true,
    execute: async (sock, m, ctx) => handleStoryUpload(sock, m, ctx, true)
};
