// delwarn.js — Quita advertencias a un miembro del grupo. Autor: Jhon 𝗖𝗜𝗗.
// Nota: el store de RemBot solo guarda la cantidad de warns por usuario
// (sin motivos ni fechas), así que aquí se quita por cantidad y no por índice.
import { getWarnCount, setWarnCount } from '../../lib/system/botstore.js'

export default {
  command: ['delwarn'],
  category: 'group',
  description: 'Quita advertencias a un miembro. Uso: delwarn @usuario [cantidad|all].',
  isAdmin: true,
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const targetId = msg.mentionedJid?.[0] || msg.quoted?.sender || null
    if (!targetId) {
      return msg.reply('Menciona o responde al usuario al que quieres quitarle advertencias.')
    }
    const total = getWarnCount(msg.chat, targetId)
    if (total === 0) {
      return sock.sendMessage(msg.chat, {
        text: `@${targetId.split('@')[0]} no tiene advertencias registradas.`,
        mentions: [targetId],
      }, { quoted: msg })
    }
    const raw = msg.mentionedJid?.length > 0 ? args[1] : args[0]
    if (typeof raw === 'string' && raw.toLowerCase() === 'all') {
      setWarnCount(msg.chat, targetId, 0)
      return sock.sendMessage(msg.chat, {
        text: `Se eliminaron todas las advertencias de @${targetId.split('@')[0]} (${total}).`,
        mentions: [targetId],
      }, { quoted: msg })
    }
    let remove = 1
    if (raw !== undefined && raw !== null && raw !== '') {
      remove = parseInt(raw, 10)
      if (Number.isNaN(remove) || remove < 1) {
        return msg.reply(`Indica cuántas advertencias quitar (1-${total}) o usa all para borrar todas.\nEjemplo: ${usedPrefix}${command} all`)
      }
      if (remove > total) {
        return msg.reply(`El usuario solo tiene ${total} advertencia(s).`)
      }
    }
    const remaining = setWarnCount(msg.chat, targetId, total - remove)
    await sock.sendMessage(msg.chat, {
      text: `Se ${remove === 1 ? 'quitó 1 advertencia' : `quitaron ${remove} advertencias`} a @${targetId.split('@')[0]}. Le quedan ${remaining}.`,
      mentions: [targetId],
    }, { quoted: msg })
  },
}
