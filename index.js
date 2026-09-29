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
    
    store.bind(sock);
    story.bind(sock);
    
    const lidMapping = sock.signalRepository.lidMapping;
    
    sock.getLIDForPN
