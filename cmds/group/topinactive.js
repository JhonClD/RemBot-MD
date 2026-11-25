// topinactive.js — Top de usuarios con menos mensajes en el grupo. Autor: Jhon 𝗖𝗜𝗗.
// Nota: el store solo guarda el total acumulado por usuario (sin desglose
// por días). Se listan todos los miembros actuales del grupo; quien no
// tiene mensajes contados aparece con 0.
import { getMessageCounts } from '../../lib/system/botstore.js'

const PER_PAGE = 10

export default {
  command: ['topinactive', 'topinactivos', 'topinactiveusers'],
  category: 'group',
  description: 'Muestra el top de usuarios con menos mensajes en el grupo. Uso: topinactive [página].',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const counts = getMessageCounts(msg.chat)
    const counted = new Map()
    for (const [jid, n] of Object.entries(counts)) {
      counted.set(jid.split('@')[0].split(':')[0], Number(n) || 0)
    }
    let ranking = []
    let participants = []
    try {
      participants = (await sock.groupMetadata(msg.chat))?.participants || []
    } catch {}
    if (participants.length > 0) {
      ranking = participants
        .map(p => p.id)
        .filter(Boolean)
        .map(jid => ({
          jid,
          total: counted.get(jid.split('@')[0]) ?? 0,
        }))
        .sort((a, b) => a.total - b.total)
    } else {
      ranking = Object.entries(counts)
        .map(([jid, n]) => ({ jid, total: Number(n) || 0 }))
        .sort((a, b) => a.total - b.total)
    }
    if (ranking.length === 0) {
      return msg.reply('No hay actividad registrada en este grupo.')
    }
    const page = parseInt(args[0], 10) || 1
    const totalPages = Math.ceil(ranking.length / PER_PAGE)
    if (page < 1 || page > totalPages) {
      return msg.reply(`Página inválida. Solo hay ${totalPages} página(s) disponible(s).`)
    }
    const start = (page - 1) * PER_PAGE
    const slice = ranking.slice(start, start + PER_PAGE)
    let report = `Top de usuarios con menos mensajes (página ${page} de ${totalPages}):\n\n`
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
