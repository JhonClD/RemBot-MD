// open.js — Abre el grupo (todos pueden escribir). Autor: Jhon 𝗖𝗜𝗗.

// Convierte '10s', '5m', '2h' o '1d' a milisegundos. Devuelve null si el formato no es válido.
function parseDuration(str) {
  const match = String(str || '').match(/^(\d+)([smhd])$/i)
  if (!match) return null
  const num = parseInt(match[1], 10)
  switch (match[2].toLowerCase()) {
    case 's': return num * 1000
    case 'm': return num * 60 * 1000
    case 'h': return num * 60 * 60 * 1000
    case 'd': return num * 24 * 60 * 60 * 1000
    default: return null
  }
}

function formatDuration(ms) {
  const d = Math.floor(ms / 86400000)
  const h = Math.floor(ms / 3600000) % 24
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  const parts = []
  if (d > 0) parts.push(`${d} ${d === 1 ? 'día' : 'días'}`)
  if (h > 0) parts.push(`${h} ${h === 1 ? 'hora' : 'horas'}`)
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minuto' : 'minutos'}`)
  if (s > 0) parts.push(`${s} ${s === 1 ? 'segundo' : 'segundos'}`)
  return parts.join(' ')
}

export default {
  command: ['open', 'abrir'],
  category: 'group',
  description: 'Abre el grupo para que todos puedan enviar mensajes. Uso: open [10s|5m|2h|1d].',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, args }) => {
    try {
      const timeout = args[0] ? parseDuration(args[0]) : 0
      if (args[0] && !timeout) {
        return msg.reply('Formato inválido. Usa por ejemplo: 10s, 5m, 2h, 1d.')
      }
      const metadata = await sock.groupMetadata(msg.chat)
      if (metadata?.announce === false) {
        return msg.reply('El grupo ya está abierto.')
      }
      const apply = async () => {
        await sock.groupSettingUpdate(msg.chat, 'not_announcement')
        await msg.reply('El grupo ha sido abierto. Todos pueden enviar mensajes.')
      }
      if (timeout > 0) {
        await msg.reply(`El grupo se abrirá en ${formatDuration(timeout)}.`)
        setTimeout(async () => {
          try {
            const md = await sock.groupMetadata(msg.chat)
            if (md?.announce === false) return
            await apply()
          } catch {}
        }, timeout)
        return
      }
      await apply()
    } catch (e) {
      await msg.reply(`No se pudo abrir el grupo. Error: ${e?.message || e}`)
    }
  },
}
