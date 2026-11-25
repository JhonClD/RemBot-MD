// warns.js — Muestra las advertencias de un miembro del grupo. Autor: Jhon 𝗖𝗜𝗗.
// Nota: el store solo guarda la cantidad de warns por usuario (sin motivos
// ni fechas), así que se muestra el total y el límite, sin el detalle
// de cada advertencia que mostraba YukiBot.
import { getChatSettings, getWarnCount } from '../../lib/system/botstore.js'

export default {
  command: ['warns'],
  category: 'group',
  description: 'Muestra las advertencias de un miembro. Uso: warns @usuario.',
  isAdmin: true,
  run: async ({ msg, sock }) => {
    const userId = msg.mentionedJid?.[0] || msg.quoted?.sender || null
    if (!userId) {
      return msg.reply('Menciona o responde a un usuario para ver sus advertencias.')
    }
    const total = getWarnCount(msg.chat, userId)
    const limit = getChatSettings(msg.chat).warnLimit ?? 3
    if (total === 0) {
      return sock.sendMessage(msg.chat, {
        text: `@${userId.split('@')[0]} no tiene advertencias registradas.`,
        mentions: [userId],
      }, { quoted: msg })
    }
    await sock.sendMessage(msg.chat, {
      text: `Advertencias de @${userId.split('@')[0]}: ${total}${limit > 0 ? `/${limit}` : ''}.`,
      mentions: [userId],
    }, { quoted: msg })
  },
}
