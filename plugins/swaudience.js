// .swaudience — control exactly who can see the stories this bot posts (.sw, .swc, .swhd, .swl, .sws, .s, .sc...).
//
//   .swaudience                                      show current mode + list
//   .swaudience add 6281234567890 6289876543210      restrict to these numbers (+ you) - turns restricted mode ON
//   .swaudience add @user1 @user2                     same, but tag the contacts instead of typing numbers
//   .swaudience remove 6281234567890                  drop one number from the restricted list
//   .swaudience set 6281234567890,6289876543210        replace the whole restricted list in one go
//   .swaudience clear                                  turn restricted mode OFF (back to: every contact can see it)
//
// While the restricted list holds at least one number, ONLY those numbers (+ you) go into
// statusJidList when a story is posted - nobody else, even if they're in your contacts.
// Numbers: plain digits with country code, no +, spaces or dashes (e.g. 6281234567890).

const { addRestricted, removeRestricted, clearRestricted, listRestricted, isRestricted, audienceSize } = require('../library/story');

const extractNumbers = (text) => (text.match(/\d{6,}/g) || []);
const short = (jid) => jid.split('@')[0];

module.exports = {
    command: 'swaudience',
    description: 'Control exactly which numbers can see the stories the bot posts',
    category: 'story',
    owner: true,
    execute: async (sock, m, { text, reply, prefix }) => {
        const parts = (text || '').trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] || '').toLowerCase();
        const restText = parts.slice(1).join(' ');
        const targets = [...extractNumbers(restText), ...(m.mentionedJid || [])];
        const list = () => listRestricted().map(short).join('\n');

        switch (sub) {
            case 'add': {
                if (!targets.length) {
                    return reply(`Give at least one number or @mention.\nExample: ${prefix}swaudience add 6281234567890`);
                }
                const before = listRestricted().length;
                addRestricted(...targets);
                const after = listRestricted().length;
                return reply(`Added ${after - before} number(s). Restricted mode is ON — only these ${after} number(s) (+ you) can see your story now:\n${list()}`);
            }
            case 'remove':
            case 'rm': {
                if (!targets.length) {
                    return reply(`Give at least one number or @mention to remove.\nExample: ${prefix}swaudience remove 6281234567890`);
                }
                removeRestricted(...targets);
                return isRestricted()
                    ? reply(`Removed. Restricted list is now ${listRestricted().length}:\n${list()}`)
                    : reply(`Removed. The restricted list is now empty, so restricted mode is OFF — your story is visible to all ${audienceSize()} contacts again.`);
            }
            case 'set': {
                if (!targets.length) {
                    return reply(`Give the numbers to set.\nExample: ${prefix}swaudience set 6281234567890,6289876543210`);
                }
                clearRestricted();
                addRestricted(...targets);
                return reply(`Restricted mode is ON — only these ${listRestricted().length} number(s) (+ you) can see your story now:\n${list()}`);
            }
            case 'clear':
            case 'off':
            case 'reset': {
                const had = clearRestricted();
                return reply(had
                    ? `Restricted mode is OFF. Your story is visible to all ${audienceSize()} contacts again.`
                    : `Restricted mode was already off (all ${audienceSize()} contacts can see your story).`);
            }
            default: {
                if (isRestricted()) {
                    return reply(
                        `*Story audience: RESTRICTED*\n` +
                        `Only these ${listRestricted().length} number(s) (+ you) can see your story:\n${list()}\n\n` +
                        `${prefix}swaudience add <number>\n${prefix}swaudience remove <number>\n${prefix}swaudience clear`
                    );
                }
                return reply(
                    `*Story audience: ALL CONTACTS* (${audienceSize()} + you)\n\n` +
                    `Restrict it to specific numbers:\n${prefix}swaudience add 6281234567890 6289876543210\n` +
                    `or tag them: ${prefix}swaudience add @user1 @user2`
                );
            }
        }
    }
};
