console.clear();
const config = () => require('./settings/config');
process.on("uncaughtException", console.error);

let makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidDecode, downloadContentFromMessage, jidNormalizedUser, isPnUser;

const loadBaileys = async () => {
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  Browsers = baileys.Browsers;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  jidDecode = baileys.jidDecode;
  downloadContentFromMessage = baileys.downloadContentFromMessage;
  jidNormalizedUser = baileys.jidNormalizedUser;
  isPnUser = baileys.isPnUser;
};

const pino = require('pino');
const FileType = require('file-type');
const readline = require("readline");
const fs = require('fs');
const chalk = require("chalk");
const path = require("path");

const { Boom } = require('@hapi/boom');
const { getBuffer } = require('./library/function');
const { smsg } = require('./library/serialize');
const { isOwnerMessage } = require('./library/owner');
const story = require('./library/story');
const { videoToWebp, writeExifImg, writeExifVid, addExif, toPTT, toAudio } = require('./library/exif');
const listcolor = ['cyan', 'magenta', 'green', 'yellow', 'blue'];
const randomcolor = listcolor[Math.floor(Math.random() * listcolor.length)];

const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(chalk.yellow(text), answer => { resolve(answer); rl.close(); });
    });
};

const clientstart = async() => {
    await loadBaileys();
    
    const browserOptions = [
        Browsers.macOS('Safari'), Browsers.macOS('Chrome'), Browsers.windows('Firefox'),
        Browsers.ubuntu('Chrome'), Browsers.baileys('Baileys'), Browsers.macOS('Edge'),
        Browsers.windows('Edge')
    ];
    const randomBrowser = browserOptions[Math.floor(Math.random() * browserOptions.length)];
    
    const store = {
        messages: new Map(),
        contacts: new Map(),
        groupMetadata: new Map(),
        loadMessage: (jid, id) => store.messages.get(`${jid}:${id}`) || null,
        bind: (ev) => {
            ev.on('messages.upsert', ({ messages }) => {
                for (const msg of messages) {
                    if (msg.key?.remoteJid && msg.key?.id) store.messages.set(`${msg.key.remoteJid}:${msg.key.id}`, msg);
                }
            });
            ev.on('lid-mapping.update', ({ mappings }) => console.log(chalk.cyan('📋 LID Mapping Update:'), mappings));
        }
    };
    
    const { state, saveCreds } = await useMultiFileAuthState(`./${config().session}`);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: !config().status.terminal,
        auth: state,
        version: version,
        browser: randomBrowser
    });
    
    if (config().status.terminal && !sock.authState.creds.registered) {
        const phoneNumber = await question('enter the WhatsApp number to link (country code first, e.g. 6285111606001):\nnumber WhatsApp: ');
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(chalk.green(`your pairing code: ` + chalk.bold.green(code)));
    }
    
    store.bind(sock.ev);
    story.bind(sock);
    
    const lidMapping = sock.signalRepository.lidMapping;
    
    sock.getLIDForPN = async (phoneNumber) => {
        try { return await lidMapping.getLIDForPN(phoneNumber); } catch {}
        return null;
    };
    sock.getPNForLID = async (lid) => {
        try { return await lidMapping.getPNForLID(lid); } catch {}
        return null;
    };
    sock.storeLIDPNMapping = async (lid, phoneNumber) => {
        try {
            await lidMapping.storeLIDPNMapping(lid, phoneNumber);
            console.log(chalk.green(`✓ Stored LID<->PN mapping: ${lid} <-> ${phoneNumber}`));
        } catch {}
    };
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (connection === 'connecting') console.log(chalk.yellow('🔄 Connecting to WhatsApp...'));
        if (connection === 'open') {
            console.log(chalk.green('✅ Connected to WhatsApp successfully!'));
            sock.sendMessage(config().owner + '@s.whatsapp.net', {
                text: `✅ *${config().settings.title}* is online\n> 🔒 Mode: Owner only (+${config().owner})\n> 📸 Story: send a photo/video as *Document* with caption .sw`
            }).catch(console.error);
        }
        if (connection === 'close') console.log(chalk.red('❌ Connection closed:'), lastDisconnect?.error?.message);
        if (qr) console.log(chalk.blue('📱 Scan the QR code above to connect.'));
        
        const { konek } = require('./library/connection/connection');
        konek({ sock, update, clientstart, DisconnectReason, Boom });
    });

    sock.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            mek.message = Object.keys(mek.message)[0] === 'ephemeralMessage' ? mek.message.ephemeralMessage.message : mek.message;
            
            if (config().status.reactsw && mek.key && mek.key.remoteJid === 'status@broadcast') {
                let emoji = ['😘', '😭', '😂', '😹', '😍', '😋', '🙏', '😜', '😢', '😠', '🤫', '😎'];
                let sigma = emoji[Math.floor(Math.random() * emoji.length)];
                await sock.readMessages([mek.key]);
                await sock.sendMessage('status@broadcast', { react: { text: sigma, key: mek.key } }, { statusJidList: [mek.key.participant] });
            }
            
            if (chatUpdate.type !== 'notify') return;
            if (mek.key.remoteJid === 'status@broadcast') return;
            const ageSec = Date.now() / 1000 - Number(mek.messageTimestamp || 0);
            if (ageSec > 180) return;
            if (!(await isOwnerMessage(sock, mek))) return;
            if (mek.key.id.startsWith('BASE-') && mek.key.id.length === 12) return;
            
            const m = await smsg(sock, mek, store);
            m.isOwner = true;
            require("./message")(sock, m, chatUpdate, store);
        } catch (err) { console.log(err); }
    });

    sock.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {};
            return decode.user && decode.server && decode.user + '@' + decode.server || jid;
        } else return jid;
    };

    sock.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = contact.id;
            if (store.contacts) store.contacts.set(id, { id, lid: contact.lid || null, phoneNumber: contact.phoneNumber || null, name: contact.notify || contact.name || null });
        }
    });

    sock.public = false;
    
    sock.sendText = async (jid, text, quoted = '', options) => sock.sendMessage(jid, { text, ...options }, { quoted });
    sock.downloadMediaMessage = async (message) => {
        let mime = (message.msg || message).mimetype || '';
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
        const stream = await downloadContentFromMessage(message, messageType);
        let buffer = Buffer.from([]);
        for await(const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    };

    sock.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
        let buffer = (options && (options.packname || options.author)) ? await writeExifImg(buff, options) : await addExif(buff);
        await sock.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
        return buffer;
    };
    
    sock.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        let quoted = message.msg ? message.msg : message;
        let mime = (message.msg || message).mimetype || "";
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, "") : mime.split("/")[0];
        const stream = await downloadContentFromMessage(quoted, messageType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        let type = await FileType.fromBuffer(buffer);
        let trueFileName = attachExtension ? filename + "." + type.ext : filename;
        await fs.writeFileSync(trueFileName, buffer);
        return trueFileName;
    };

    sock.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
        let buffer = (options && (options.packname || options.author)) ? await writeExifVid(buff, options) : await videoToWebp(buff);
        await sock.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
        return buffer;
    };

    sock.getFile = async (PATH, returnAsFilename) => {
        let res, filename;
        const data = Buffer.isBuffer(PATH) ? PATH : /^data:.*?\/.*?;base64,/i.test(PATH) ? Buffer.from(PATH.split`,`[1], 'base64') : /^https?:\/\//.test(PATH) ? (res = await fetch(PATH)).buffer() : fs.existsSync(PATH) ? (filename = PATH, fs.readFileSync(PATH)) : typeof PATH === 'string' ? PATH : Buffer.alloc(0);
        if (!Buffer.isBuffer(data)) throw new TypeError('Result is not a buffer');
        const type = await FileType.fromBuffer(data) || { mime: 'application/octet-stream', ext: '.bin' };
        if (data && returnAsFilename && !filename) {
            filename = path.join(__dirname, './tmp/' + new Date() * 1 + '.' + type.ext);
            await fs.promises.writeFile(filename, data);
        }
        return { res, filename, ...type, data, deleteFile() { return filename && fs.promises.unlink(filename); } };
    };
    
    sock.sendFile = async (jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) => {
        let type = await sock.getFile(path, true);
        let { res, data: file, filename: pathFile } = type;
        if (res && res.status !== 200 || file.length <= 65536) try { throw { json: JSON.parse(file.toString()) }; } catch (e) { if (e.json) throw e.json; }
        let opt = { filename };
        if (quoted) opt.quoted = quoted;
        if (!type) options.asDocument = true;
        let mtype = '', mimetype = type.mime, convert;
        if (/webp/.test(type.mime) || (/image/.test(type.mime) && options.asSticker)) mtype = 'sticker';
        else if (/image/.test(type.mime) || (/webp/.test(type.mime) && options.asImage)) mtype = 'image';
        else if (/video/.test(type.mime)) mtype = 'video';
        else if (/audio/.test(type.mime)) {
            convert = await (ptt ? toPTT : toAudio)(file, type.ext);
            file = convert.data;
            pathFile = convert.filename;
            mtype = 'audio';
            mimetype = 'audio/ogg; codecs=opus';
        } else mtype = 'document';
        if (options.asDocument) mtype = 'document';
        let message = { ...options, caption, ptt, [mtype]: { url: pathFile }, mimetype };
        let m;
        try {
            m = await sock.sendMessage(jid, message, { ...opt, ...options });
        } catch (e) {
            console.error(e);
            m = await sock.sendMessage(jid, { ...message, [mtype]: file }, { ...opt, ...options });
        }
        return m;
    };

    return sock;
};

clientstart();

const ignoredErrors = ['Socket connection timeout', 'EKEYTYPE', 'item-not-found', 'rate-overlimit', 'Connection Closed', 'Timed Out', 'Value not found'];

let file = require.resolve(__filename);
require('fs').watchFile(file, () => {
  delete require.cache[file];
  require(file);
});

process.on('unhandledRejection', reason => {
    if (ignoredErrors.some(e => String(reason).includes(e))) return;
    console.log('Unhandled Rejection:', reason);
});

const originalConsoleError = console.error;
console.error = function (msg, ...args) {
    if (typeof msg === 'string' && ignoredErrors.some(e => msg.includes(e))) return;
    originalConsoleError.apply(console, [msg, ...args]);
};

const originalStderrWrite = process.stderr.write;
process.stderr.write = function (msg, encoding, fd) {
    if (typeof msg === 'string' && ignoredErrors.some(e => msg.includes(e))) return;
    originalStderrWrite.apply(process.stderr, arguments);
};
