import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'

function formatMs(value) {
  return `${Math.max(0, Math.round(value))}ms`
}

function formatUptime(seconds) {
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  if (minutes || hours || days) parts.push(`${minutes}m`)
  parts.push(`${secs}s`)
  return parts.join(' ')
}

function memoryUsage() {
  const used = process.memoryUsage().rss / 1024 / 1024
  return `${used.toFixed(1)} MB`
}

async function sendPing({ msg, sock, detailed }) {
  const started = performance.now()
  let response

  try {
    response = await msg.reply('🏓 Comprobando...')
    const responseMs = performance.now() - started
    const host = os.hostname()
    const uptime = formatUptime(process.uptime())
    const text = detailed
      ? [
          '🏓 *Pong*',
          '',
          `⚡ Respuesta: *${formatMs(responseMs)}*`,
          `📡 Estado: *En línea*`,
          `⏱️ Uptime: *${uptime}*`,
          `🧠 RAM: *${memoryUsage()}*`,
          `🟢 Node: *${process.version}*`,
          `💻 Host: *${host}*`,
        ].join('\n')
      : `🏓 ${formatMs(responseMs)} 💠`

    if (response?.key && sock?.sendMessage) {
      await sock.sendMessage(msg.chat, { text, edit: response.key })
    } else if (response?.edit) {
      await response.edit(text)
    } else {
      await msg.reply(text)
    }
  } catch (error) {
    console.error('[ping] error:', error?.stack || error)
    await msg.reply('❎ No pude medir el tiempo de respuesta.')
  }
}

export default {
  command: ['p', 'ping'],
  category: 'general',
  description: 'Muestra el tiempo de respuesta del bot o un diagnóstico detallado.',
  run: async (context) => sendPing({ ...context, detailed: context.command === 'ping' }),
}
