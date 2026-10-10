// Run bot commands from the server console.
// A line that starts with "." goes through the same message handler as a WhatsApp
// message from the owner. Replies are printed in this console instead of being sent
// to WhatsApp. Anyone who can use the console can run owner commands.
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = () => require('../settings/config');

// A fake chat that exists only here. Anything the bot sends to it is printed.
const TERMINAL_CHAT = 'terminal@local';
const OUT_DIR = path.join(__dirname, '..', 'terminal-output');
const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'];
const EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
};

let activeSock = null;
let inputStarted = false;
const wrapped = new WeakSet();

const ownerJid = () => {
    const owner = String(config().owner || '').replace(/\D/g, '');
    return owner ? owner + '@s.whatsapp.net' : null;
};

function saveMedia(buffer, kind, content) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const ext = EXTENSIONS[content.mimetype]
        || (content.fileName ? path.extname(content.fileName).slice(1) : '')
        || 'bin';
    const file = path.join(OUT_DIR, `${Date.now()}-${kind}.${ext}`);
    fs.writeFileSync(file, buffer);
    return path.relative(path.join(__dirname, '..'), file);
}

function printReply(content) {
    const key = { remoteJid: TERMINAL_CHAT, fromMe: true, id: 'TERM-OUT-' + crypto.randomBytes(4).toString('hex') };
    // Reactions, deletes and edits have nothing to show in a console.
    if (!content || typeof content !== 'object' || content.react || content.delete || content.edit) {
        return { key };
    }
    const kind = MEDIA_KEYS.find((k) => content[k] !== undefined);
    if (kind) {
        if (content.caption) console.log(content.caption);
        const value = content[kind];
        if (Buffer.isBuffer(value)) {
            console.log(`[${kind} saved to ${saveMedia(value, kind, content)}]`);
        } else if (typeof value === 'string') {
            console.log(`[${kind}] ${value}`);
        } else if (value && value.url) {
            console.log(`[${kind}] ${value.url}`);
        } else {
            console.log(`[${kind} sent]`);
        }
    } else if (typeof content.text === 'string') {
        console.log(content.text);
    } else {
        console.log('[reply]', Object.keys(content).join(', '));
    }
    return { key, message: content };
}

function wrapSocket(sock) {
    if (wrapped.has(sock)) return;
    wrapped.add(sock);
    const send = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        if (jid !== TERMINAL_CHAT) return send(jid, content, options);
        try {
            return printReply(content);
        } catch (err) {
            console.log('[terminal] Could not show the reply:', err.message || err);
            return { key: { remoteJid: TERMINAL_CHAT, fromMe: true, id: 'TERM-ERR' } };
        }
    };
}

function handleLine(line) {
    const text = String(line || '').trim();
    if (!text.startsWith('.')) return; // ignore anything that is not a bot command
    if (!activeSock || !activeSock.user) {
        console.log('[terminal] WhatsApp is not connected yet. Try again once the bot is online.');
        return;
    }
    const owner = ownerJid();
    if (!owner) {
        console.log('[terminal] Set the owner number in settings/config.js first.');
        return;
    }
    // Shaped like a private message from the owner, so the owner check in
    // library/owner.js accepts it. Its chat is the terminal, so replies come back here.
    const message = {
        key: {
            remoteJid: TERMINAL_CHAT,
            fromMe: false,
            id: 'TERM-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
            participant: owner,
            senderPn: owner,
        },
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Terminal',
    };
    try {
        activeSock.ev.emit('messages.upsert', { messages: [message], type: 'notify' });
    } catch (err) {
        console.log('[terminal] Could not run that command:', err.message || err);
    }
}

// index.js calls this each time it creates a WhatsApp connection.
function attach(sock) {
    activeSock = sock;
    wrapSocket(sock);
    if (inputStarted) return;
    inputStarted = true;
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', handleLine);
    console.log('[terminal] You can also run commands here, for example .menu');
}

module.exports = { attach };
