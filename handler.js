import { getPrefix, getOwnerJid, getChatSettings, bumpMessageCount } from './lib/system/botstore.js';

const NEWSLETTER_ROLE_TTL_MS = 60_000;
const newsletterRoleCache = new Map();

async function getNewsletterViewerRole(sock, jid) {
  if (!jid || typeof sock?.newsletterMetadata !== 'function') return '';
  const now = Date.now();
  const cached = newsletterRoleCache.get(jid);
  if (cached && cached.expiresAt > now) return cached.role;
  try {
    const meta = await sock.newsletterMetadata('jid', jid);
    const role = String(
      meta?.viewer_metadata?.role
      ?? meta?.viewerMetadata?.role
      ?? meta?.role
      ?? ''
    ).trim().toUpperCase();
    if (role) {
      newsletterRoleCache.set(jid, { role, expiresAt: now + NEWSLETTER_ROLE_TTL_MS });
    }
    return role;
  } catch {
    return '';
  }
}

export default async function handler(sock, msg) {
  if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return;
  if (msg.fromMe && !msg.key?.participant && msg.isBot) return;
  if (msg.isGroup && msg.sender) bumpMessageCount(msg.chat || msg.key?.remoteJid, msg.sender);
  if (msg.usedPrefix !== getPrefix()) return;

  const command = String(msg.command || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!command) return;

  const cmdData = global.comandos?.get(command);
  if (!cmdData) return;

  const ownerNumbers = [...new Set([
    ...(global.owner || []),
    '51925092348',
    getOwnerJid(),
  ].map((number) => String(number).replace(/\D/g, '')).filter(Boolean))];
  const ownerLids = [...new Set(String(process.env.BOT_OWNER_LID || '')
    .split(',')
    .map((number) => number.replace(/\D/g, ''))
    .filter(Boolean)
    .concat('162234554671342'))];
  const ownerChannels = [...new Set(String(process.env.BOT_OWNER_CHANNELS || '')
    .split(',')
    .map((item) => item.trim().split('@')[0].replace(/\D/g, ''))
    .filter(Boolean))];
  const owners = ownerNumbers.map((number) => `${number}@s.whatsapp.net`);
  const sender = msg.sender || '';
  const chatJid = String(msg.chat || msg.key?.remoteJid || '');
  const isNewsletter = chatJid.endsWith('@newsletter');
  const senderCandidates = [
    sender,
    msg.key?.participant,
    msg.key?.participantAlt,
    msg.key?.remoteJid,
    msg.key?.remoteJidAlt,
    ...(msg.fromMe ? [sock.user?.id, sock.user?.lid] : []),
  ].filter(Boolean);
  const senderBases = senderCandidates.map((jid) => String(jid).split('@')[0].split(':')[0]);
  let isOwner = owners.includes(sender)
    || senderBases.some((base) => ownerNumbers.includes(base) || ownerLids.includes(base));

  // Grupo con el bot apagado (`bot off`): solo el dueño puede volver a encenderlo.
  if (msg.isGroup && command !== 'bot' && !isOwner && getChatSettings(chatJid).enabled === false) return;

  let groupMetadata = null;
  let participants = [];
  let isAdmins = false;
  let isBotAdmins = false;

  if (isNewsletter) {
    const channelBase = chatJid.split('@')[0].replace(/\D/g, '');
    if (channelBase && ownerChannels.includes(channelBase)) {
      isOwner = true;
      isAdmins = true;
      isBotAdmins = true;
    } else {
      const role = await getNewsletterViewerRole(sock, chatJid);
      if (role === 'OWNER' || role === 'ADMIN') {
        isOwner = true;
        isAdmins = true;
        isBotAdmins = true;
      }
    }
  }

  if (cmdData.isOwner && !isOwner) return;

  if (msg.isGroup && (cmdData.isAdmin || cmdData.botAdmin)) {
    groupMetadata = await sock.groupMetadata(msg.chat).catch(() => null);
    participants = groupMetadata?.participants || [];
    const senderBase = sender.split('@')[0].split(':')[0];
    const botBase = sock.user?.id?.split(':')[0];
    const admins = new Set(participants
      .filter((participant) => participant.admin === 'admin' || participant.admin === 'superadmin')
      .flatMap((participant) => [participant.id, participant.lid, participant.phoneNumber]
        .filter(Boolean)
        .map((jid) => jid.split('@')[0].split(':')[0])));
    isAdmins = admins.has(senderBase);
    isBotAdmins = admins.has(botBase);
  }

  if (cmdData.isAdmin && !isAdmins) return;
  if (cmdData.botAdmin && !isBotAdmins) return;

  const args = Array.isArray(msg.args) ? msg.args : [];
  const usedPrefix = msg.usedPrefix || '';
  const text = args.join(' ');

  try {
    await cmdData.run({
      msg,
      sock,
      args,
      command,
      usedPrefix,
      text,
      groupMetadata,
      participants,
      isAdmins,
      isBotAdmins,
      isOwner,
      __dirname: global.plugins?.[cmdData.pluginKey]?.dirname
    });
  } catch (error) {
    console.error(`[command:${command}]`, error?.stack || error);
    await msg.reply?.('No se pudo completar el comando. Revisa los registros del bot.');
  }
}
