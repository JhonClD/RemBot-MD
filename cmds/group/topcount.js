// topcount.js — Top de usuarios con más mensajes en el grupo. Autor: Jhon 𝗖𝗜𝗗.
// Nota: el store solo guarda el total acumulado por usuario (sin desglose
// por días), así que el argumento es la página y no el rango de días.
import { getMessageCounts } from '../../lib/system/botstore.js'

const PER_PAGE = 10

export default {
  command: ['topcount', 'topmensajes', 'topmsgcount', 'topmessages'],
  category: 'group',
  description: 'Muestra el top de usuarios con más mensajes en el grupo. Uso: topcount [página].',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const counts = getMessageCounts(msg.chat)
    const ranking = Object.entries(counts)
      .map(([jid, n]) => ({ jid, total: Number(n) || 0 }))
      .filter(u => u.total > 0)
      .sort((a, b) => b.total - a.total)
    if (ranking.length === 0) {
      return msg.reply('No hay mensajes registrados en este grupo todavía.')
    }
    const page = parseInt(args[0], 10) || 1
    const totalPages = Math.ceil(ranking.length / PER_PAGE)
    if (page < 1 || page > totalPages) {
      return msg.reply(`Página inválida. Solo hay ${totalPages} página(s) disponible(s).`)
    }
    const start = (page - 1) * PER_PAGE
    const slice = ranking.slice(start, start + PER_PAGE)
    let report = `Top de mensajes en este grupo (página ${page} de ${totalPages}):\n\n`
    slice.forEach((u, i) => {
      report += `${start + i + 1}. @${u.jid.split('@')[0]} — ${u.total} mensajes\n`
    })
    if (page < totalPages) {
      report += `\nSiguiente página: ${usedPrefix}${command} ${page + 1}`
    }
    await sock.sendMessage(msg.chat, {
      text: report.trim(),
      mentions: slice.map(u => u.jid),
    }, { quoted: msg })
  },
}
