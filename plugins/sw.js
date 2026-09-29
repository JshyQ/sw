const { handleStoryUpload } = require('../library/storyUpload');

module.exports = {
    command: 'sw',
    description: 'Post image/video to your story, video upgraded to HD at the same file size',
    category: 'story',
    owner: true,
    execute: async (sock, m, ctx) => handleStoryUpload(sock, m, ctx, false)
};
