const { deleteAllStories, listPosted } = require('../library/story');

module.exports = {
    command: 'delstory',
    description: 'Delete all your WhatsApp stories posted through the bot',
    category: 'story',
    owner: true,
    execute: async (sock, m, { reply }) => {
        const pending = listPosted().length;
        if (pending === 0) {
            return reply('No tracked stories to delete. This only catches stories posted while the bot was online (from any device) — WhatsApp has no way to look up older ones after the fact.');
        }

        await reply(`Deleting ${pending} story${pending === 1 ? '' : 'ies'}...`);

        const { deleted, failed } = await deleteAllStories(sock);

        let msg = `Deleted ${deleted} of ${pending} story${pending === 1 ? '' : 'ies'}.`;
        if (failed > 0) {
            msg += `\n${failed} could not be deleted (likely already expired/removed or older than 24h) and were left for a retry.`;
        }
        await reply(msg);
    }
};
