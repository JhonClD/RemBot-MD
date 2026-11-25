// botstore.js — Ajustes persistentes de RemBot-MD (JSON, estilo Rem).
// Guarda lo que antes vivía en la base de datos de YukiBot y que RemBot
// necesita para los comandos de grupo y de menú: ajustes del bot,
// ajustes por grupo (bienvenida, despedida, warns, límite de warns,
// banner del grupo, bot activado o no) y contadores de mensajes por grupo.
// Sin dependencias nuevas: solo node:fs. El archivo botstore.json se crea
// en la primera escritura; no se sube a git (ver .gitignore).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STORE_PATH = path.join(__dirname, 'botstore.json');
export const DEFAULT_PREFIX = '`';

const SAVE_DELAY_MS = 1500;

function defaultStore() {
  return {
    version: 1,
    bot: {
      name: 'RemBot-MD',
      banner: '',
      icon: '',
      status: '',
      link: '',
      channelId: '',
      channelName: '',
      currency: '',
      username: '',
      owner: '',
      prefix: DEFAULT_PREFIX,
    },
    chats: {},
    stats: {},
  };
}

function defaultChatSettings() {
  return {
    enabled: true,
    welcome: '',
    goodbye: '',
    gpbanner: '',
    warnLimit: 3,
    warns: {},
  };
}

let cache = null;
let saveTimer = null;

export function loadStore() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = { ...defaultStore(), ...parsed };
    cache.bot = { ...defaultStore().bot, ...(parsed.bot || {}) };
    cache.chats = parsed.chats || {};
    cache.stats = parsed.stats || {};
  } catch {
    cache = defaultStore();
  }
  return cache;
}

function saveNow() {
  saveTimer = null;
  try {
    const tmpPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(loadStore(), null, 2), 'utf8');
    fs.renameSync(tmpPath, STORE_PATH);
  } catch (error) {
    console.error('[botstore]', error?.message || error);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

export function saveStore() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
}

// ---------- Ajustes del bot (menú / perfil) ----------

export function getBotSettings() {
  return { ...loadStore().bot };
}

export function updateBotSettings(patch = {}) {
  const store = loadStore();
  const allowed = ['name', 'banner', 'icon', 'status', 'link', 'channelId', 'channelName', 'currency', 'username', 'owner'];
  for (const key of allowed) {
    if (patch[key] !== undefined) store.bot[key] = String(patch[key]);
  }
  scheduleSave();
  return getBotSettings();
}

export function getPrefix() {
  const prefix = String(loadStore().bot.prefix || '').trim();
  if ([...prefix].length === 1 && /^[^\p{L}\p{N}\s]$/u.test(prefix)) return prefix;
  return DEFAULT_PREFIX;
}

export function setPrefix(value) {
  const prefix = String(value || '').trim();
  if ([...prefix].length !== 1 || !/^[^\p{L}\p{N}\s]$/u.test(prefix)) {
    return { ok: false, error: 'El prefijo debe ser un solo símbolo (por ejemplo `, !, . o #).' };
  }
  loadStore().bot.prefix = prefix;
  scheduleSave();
  return { ok: true, prefix };
}

export function getOwnerJid() {
  return String(loadStore().bot.owner || '').trim();
}

export function setOwnerJid(jid) {
  loadStore().bot.owner = String(jid || '').trim();
  scheduleSave();
  return getOwnerJid();
}

// ---------- Ajustes por grupo ----------

export function getChatSettings(chatJid) {
  const store = loadStore();
  const chatId = String(chatJid || '');
  return { ...defaultChatSettings(), ...(store.chats[chatId] || {}) };
}

export function updateChatSettings(chatJid, patch = {}) {
  const store = loadStore();
  const chatId = String(chatJid || '');
  const current = getChatSettings(chatId);
  const allowed = ['enabled', 'welcome', 'goodbye', 'gpbanner', 'warnLimit'];
  for (const key of allowed) {
    if (patch[key] !== undefined) current[key] = patch[key];
  }
  if (!store.chats[chatId]) store.chats[chatId] = {};
  Object.assign(store.chats[chatId], current);
  scheduleSave();
  return getChatSettings(chatId);
}

// ---------- Warns por grupo ----------

export function getWarns(chatJid) {
  const settings = getChatSettings(chatJid);
  return { ...(settings.warns || {}) };
}

export function getWarnCount(chatJid, userJid) {
  const warns = getWarns(chatJid);
  return Number(warns[String(userJid)] || 0);
}

export function setWarnCount(chatJid, userJid, count) {
  const store = loadStore();
  const chatId = String(chatJid || '');
  const userId = String(userJid || '');
  if (!store.chats[chatId]) store.chats[chatId] = { ...defaultChatSettings() };
  if (!store.chats[chatId].warns) store.chats[chatId].warns = {};
  if (count <= 0) delete store.chats[chatId].warns[userId];
  else store.chats[chatId].warns[userId] = count;
  scheduleSave();
  return Math.max(0, count);
}

export function clearWarns(chatJid) {
  const store = loadStore();
  const chatId = String(chatJid || '');
  if (store.chats[chatId]) store.chats[chatId].warns = {};
  scheduleSave();
}

// ---------- Contadores de mensajes por grupo ----------

export function bumpMessageCount(chatJid, userJid) {
  const store = loadStore();
  const chatId = String(chatJid || '');
  const userId = String(userJid || '');
  if (!chatId || !userId) return;
  if (!store.stats[chatId]) store.stats[chatId] = {};
  store.stats[chatId][userId] = (Number(store.stats[chatId][userId]) || 0) + 1;
  scheduleSave();
}

export function getMessageCounts(chatJid) {
  const store = loadStore();
  return { ...(store.stats[String(chatJid || '')] || {}) };
}

export function clearMessageCounts(chatJid) {
  const store = loadStore();
  delete store.stats[String(chatJid || '')];
  scheduleSave();
}
