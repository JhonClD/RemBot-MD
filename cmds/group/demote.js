// demote.js — Degrada a un administrador del grupo. Autor: Jhon 𝗖𝗜𝗗.
import { getOwnerJid } from '../../lib/system/botstore.js'

// Base numérica de un JID (sin @s.whatsapp.net, sin :dispositivo).
function base(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

// Bases numéricas de los dueños del bot. Corrige el bug de YukiBot
// (`global.owner + '@s.whatsapp.net'`): global.owner es un array.
function ownerBases() {
  const raw = Array.isArray(global.owner) ? global.owner : (global.owner ? [global.owner] : [])
  const bases = new Set()
  for (const entry of raw) {
    const value = typeof entry === 'string' ? entry : (entry?.jid ?? entry?.number ?? '')
    const digits = base(value).replace(/\D/g, '')
    if (digits) bases.add(digits)
  }
  const stored = base(getOwnerJid()).replace(/\D/g, '')
  if (stored) bases.add(stored)
  return bases
}

export default {
  command: ['demote', 'degradar'],
  category: 'group',
  description: 'Degrada a un usuario de administrador. Uso: demote @usuario.',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, groupMetadata, participants }) => {
    const who = msg.mentionedJid?.[0] || msg.quoted?.sender
    if (!who) return msg.reply('Menciona al usuario que quieres degradar de administrador.')
    try {
      const ownerGroup = groupMetadata?.owner || `${msg.chat.split('-')[0]}@s.whatsapp.net`
      const owners = ownerBases()
      const whoBase = base(who)
      const participant = (participants || []).find(p => base(p.id) === whoBase || base(p.lid) === whoBase)
      if (!participant?.admin) {
        return sock.sendMessage(msg.chat, {
          text: `@${whoBase} no es administrador del grupo.`,
          mentions: [who],
        }, { quoted: msg })
      }
      const targetJid = participant?.id || who
      if (targetJid === ownerGroup) return msg.reply('No puedes degradar al creador del grupo.')
      if (owners.has(base(targetJid).replace(/\D/g, ''))) return msg.reply('No puedes degradar al dueño del bot.')
      if (targetJid === sock.decodeJid(sock.user.id)) return msg.reply('No puedes degradar al bot.')
      await sock.groupParticipantsUpdate(msg.chat, [targetJid], 'demote')
      await sock.sendMessage(msg.chat, {
        text: `@${whoBase} ha sido degradado de administrador del grupo.`,
        mentions: [who],
      }, { quoted: msg })
    } catch (e) {
      await msg.reply(`No se pudo degradar al usuario. Error: ${e?.message || e}`)
    }
  },
}
