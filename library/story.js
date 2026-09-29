// Story (WhatsApp status) helper.
// - keeps the list of people who can see your story (your contacts)
// - posts media to status@broadcast WITHOUT re-encoding, so quality stays as-is

const fs = require('fs');
const path = require('path');

const config = () => require('../settings/config');
const FILE = path.join(__dirname, 'database', 'story-audience.json');

const audience = new Set();
try {
    for (const jid of JSON.parse(fs.readFileSync(FILE, 'utf8'))) audience.add(jid);
} catch {}

let saveTimer = null;
const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.writeFile(FILE, JSON.stringify([...audience]), () => {});
    }, 3000);
};

// accepts "6285..@s.whatsapp.net", "6285..:12@s.whatsapp.net" or bare digits
const toPnJid = (v) => {
    if (typeof v !== 'string') return null;
    if (/^\d{6,}$/.test(v)) return v + '@s.whatsapp.net';
    if (!v.endsWith('@s.whatsapp.net')) return null;
    return v.split('@')[0].split(':')[0] + '@s.whatsapp.net';
};

const add = (...candidates) => {
    for (const c of candidates) {
        const jid = toPnJid(c);
        if (jid && !audience.has(jid)) {
            audience.add(jid);
            scheduleSave();
        }
    }
};

const addContact = (c) => c && add(c.phoneNumber, c.id);

const bind = (sock) => {
    sock.ev.on('messaging-history.set', ({ contacts = [] }) => contacts.forEach(addContact));
    sock.ev.on('contacts.upsert', (list) => list.forEach(addContact));
    sock.ev.on('contacts.update', (list) => list.forEach(addContact));

    if (config().story?.includeChatPartners) {
        sock.ev.on('messages.upsert', ({ messages }) => {
            for (const mk of messages) {
                const k = mk.key || {};
                if (k.remoteJid && !k.remoteJid.endsWith('@g.us') && k.remoteJid !== 'status@broadcast') {
                    add(k.remoteJidAlt, k.remoteJid);
                }
            }
        });
    }
};

const ownJid = (sock) => sock.user.id.split('@')[0].split(':')[0] + '@s.whatsapp.net';

const getAudience = (sock) => [...new Set([ownJid(sock), ...audience])];

// buffer must be the ORIGINAL bytes (no resize / re-encode)
const postStory = async (sock, { buffer, mimetype, caption }) => {
    const isVideo = /^video\//.test(mimetype);
    const content = isVideo ? { video: buffer, mimetype } : { image: buffer, mimetype };
    if (caption) content.caption = caption;

    const statusJidList = getAudience(sock);
    await sock.sendMessage('status@broadcast', content, { statusJidList });
    return { recipients: statusJidList.length };
};

module.exports = { bind, add, getAudience, postStory, audienceSize: () => audience.size };
