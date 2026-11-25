// count.js — Contador de mensajes de un usuario en el grupo. Autor: Jhon 𝗖𝗜𝗗.
import { getMessageCounts } from '../../lib/system/botstore.js'

export default {
  command: ['count', 'mensajes', 'messages', 'msgcount'],
  category: 'group',
  description: 'Muestra cuántos mensajes lleva un usuario en este grupo.',
  run: async ({ msg, sock }) => {
    const who = msg.mentionedJid?.[0] || msg.quoted?.sender || msg.sender
    const counts = getMessageCounts(msg.chat)
    const total = Number(counts[who] || 0)
    if (total === 0) {
      return sock.sendMessage(msg.chat, {
        text: `@${who.split('@')[0]} no tiene mensajes registrados en este grupo.`,
        mentions: [who],
      }, { quoted: msg })
    }
    await sock.sendMessage(msg.chat, {
      text: `Contador de mensajes de @${who.split('@')[0]}\nTotal en este grupo: ${total} mensajes.`,
      mentions: [who],
    }, { quoted: msg })
  },
}
