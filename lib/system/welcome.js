// welcome.js — Mensajes de bienvenida y despedida por grupo (estilo Rem).
// Lo dispara index.js en "group-participants.update". Lee el texto y el
// banner del grupo desde el store (comandos `setwelcome`, `setgoodbye` y
// `setgpbanner`); texto vacío = desactivado. Variables del texto:
// @user (mención), @group (nombre), @desc (descripción),
// @members (miembros actuales) y @time (fecha y hora de Lima).

import { getChatSettings } from './botstore.js';

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(date);
}

function fillTemplate(template, { userJid, groupName, groupDesc, memberCount }) {
  const userNumber = String(userJid || '').split('@')[0];
  return String(template)
    .replaceAll('@user', `@${userNumber}`)
    .replaceAll('@group', groupName || '')
    .replaceAll('@desc', groupDesc || '')
    .replaceAll('@members', String(memberCount ?? ''))
    .replaceAll('@time', formatTime());
}

export async function handleGroupParticipants(sock, { id, participants, action }) {
  if (!id || !Array.isArray(participants) || !participants.length) return;
  if (action !== 'add' && action !== 'remove') return;
  const settings = getChatSettings(id);
  const template = action === 'add' ? settings.welcome : settings.goodbye;
  if (!template) return;

  let metadata = null;
  try {
    metadata = await sock.groupMetadata(id);
  } catch {}
  const memberCount = metadata?.participants?.length ?? '';

  for (const userJid of participants) {
    const text = fillTemplate(template, {
      userJid,
      groupName: metadata?.subject || '',
      groupDesc: metadata?.desc || '',
      memberCount,
    });
    try {
      const banner = action === 'add' ? settings.gpbanner : '';
      if (banner && /^https?:\/\//.test(banner)) {
        await sock.sendMessage(id, { image: { url: banner }, caption: text, mentions: [userJid] });
      } else {
        await sock.sendMessage(id, { text, mentions: [userJid] });
      }
    } catch (error) {
      console.error('[welcome]', error?.message || error);
    }
  }
}
