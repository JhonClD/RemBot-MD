// warn.js — Advierte a un miembro del grupo. Autor: Jhon 𝗖𝗜𝗗.
// Nota: el store solo guarda la cantidad de warns por usuario (sin motivos
// ni fechas), así que el listado de motivos no se puede reconstruir.
// Al llegar al límite (warnLimit > 0) se intenta expulsar al usuario; eso
// requiere que el bot sea admin: si no lo es, se avisa y la advertencia
// queda registrada igualmente.
import { getChatSettings, getWarnCount, setWarnCount } from '../../lib/system/botstore.js'

export default {
  command: ['warn'],
  category: 'group',
  description: 'Advierte a un miembro. Al llegar al límite, se le expulsa. Uso: warn @usuario [motivo].',
  isAdmin: true,
  run: async ({ msg, sock, args }) => {
    const targetId = msg.mentionedJid?.[0] || msg.quoted?.sender || null
    if (!targetId) {
      return msg.reply('Menciona o responde al usuario que quieres advertir.')
    }
    const reason = (msg.mentionedJid?.length > 0 ? args.slice(1) : args).join(' ').trim() || 'Sin motivo.'
    const total = setWarnCount(msg.chat, targetId, getWarnCount(msg.chat, targetId) + 1)
    const limit = getChatSettings(msg.chat).warnLimit ?? 3
    let message = `Advertencia para @${targetId.split('@')[0]}.\nMotivo: ${reason}\nAdvertencias: ${total}${limit > 0 ? `/${limit}` : ''}.`
    if (limit > 0 && total >= limit) {
      try {
        await sock.groupParticipantsUpdate(msg.chat, [targetId], 'remove')
        setWarnCount(msg.chat, targetId, 0)
        message += '\n\nEl usuario alcanzó el límite de advertencias y fue expulsado del grupo.'
      } catch {
        message += '\n\nEl usuario alcanzó el límite, pero no se pudo expulsar automáticamente (el bot necesita ser administrador).'
      }
    }
    await sock.sendMessage(msg.chat, { text: message, mentions: [targetId] }, { quoted: msg })
  },
}
