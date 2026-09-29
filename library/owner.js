// Owner-only guard.
// A message is accepted ONLY if it comes from the number in settings/config.js -> owner.
// Comparison is on exact digits (no "includes"), and LIDs are resolved back to phone numbers.

const config = () => require('../settings/config');

const digits = (v) => String(v || '').replace(/\D/g, '');
const jidUser = (jid) => String(jid || '').split('@')[0].split(':')[0];
const jidServer = (jid) => String(jid || '').split('@')[1] || '';

const lidToNumber = new Map(); // "1234@lid" -> "6285..."
let ownerLidUser = null;       // cached "1234" part of the owner's LID

async function toNumber(sock, jid) {
    if (!jid || typeof jid !== 'string') return null;
    const server = jidServer(jid);

    if (server === 's.whatsapp.net') return digits(jidUser(jid));

    if (server === 'lid') {
        const key = jidUser(jid) + '@lid';
        if (lidToNumber.has(key)) return lidToNumber.get(key);
        try {
            const pn = sock.getPNForLID ? await sock.getPNForLID(key) : null;
            const num = pn ? digits(jidUser(pn)) : null;
            if (num) lidToNumber.set(key, num);
            return num;
        } catch {
            return null;
        }
    }
    return null;
}

async function getOwnerLidUser(sock, owner) {
    if (ownerLidUser) return ownerLidUser;
    try {
        const lid = sock.getLIDForPN ? await sock.getLIDForPN(owner + '@s.whatsapp.net') : null;
        if (lid) ownerLidUser = jidUser(lid);
    } catch {}
    return ownerLidUser;
}

async function isOwnerMessage(sock, mek) {
    const owner = digits(config().owner);
    if (!owner) return false;

    const key = mek?.key;
    if (!key || !key.remoteJid) return false;
    if (key.remoteJid === 'status@broadcast') return false;

    // Sent from the linked account itself: only the owner if that account IS the owner's number.
    if (key.fromMe) return digits(jidUser(sock.user?.id)) === owner;

    const isGroup = key.remoteJid.endsWith('@g.us');
    const candidates = isGroup
        ? [key.participant, key.participantAlt, key.participantPn]
        : [key.remoteJid, key.remoteJidAlt, key.senderPn];

    const ownerLid = await getOwnerLidUser(sock, owner);

    for (const jid of candidates) {
        if (!jid) continue;
        if (ownerLid && jidServer(jid) === 'lid' && jidUser(jid) === ownerLid) return true;
        const num = await toNumber(sock, jid);
        if (num && num === owner) return true;
    }
    return false;
}

module.exports = { isOwnerMessage, digits };
