import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const IMAGE_PATH = path.join(REPO_ROOT, 'assets', 'rem-host.png')
const BAR_LENGTH = 10

function formatUptime(seconds) {
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

function bar(percent) {
  const filled = Math.max(0, Math.min(BAR_LENGTH, Math.round(percent / 100 * BAR_LENGTH)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_LENGTH - filled)}`
}

function percent(value, total) {
  return total > 0 ? Math.max(0, Math.min(100, Math.round(value / total * 100))) : 0
}

function readCpuTimes() {
  return os.cpus().map(({ times }) => ({ idle: times.idle, total: Object.values(times).reduce((sum, value) => sum + value, 0) }))
}

async function cpuPercent() {
  const before = readCpuTimes()
  await new Promise(resolve => setTimeout(resolve, 120))
  const after = readCpuTimes()
  const total = after.reduce((sum, cpu, i) => sum + Math.max(0, cpu.total - before[i].total), 0)
  const idle = after.reduce((sum, cpu, i) => sum + Math.max(0, cpu.idle - before[i].idle), 0)
  return total ? Math.round((total - idle) / total * 100) : 0
}

async function memoryStats() {
  try {
    const [currentText, limitText] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/memory.current', 'utf8'),
      fs.readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ])
    const current = Number(currentText.trim())
    const limit = Number(limitText.trim())
    if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER) {
      return { used: current, total: limit }
    }
  } catch {}
  try {
    const [currentText, limitText] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'),
      fs.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'),
    ])
    const current = Number(currentText.trim())
    const limit = Number(limitText.trim())
    if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER) {
      return { used: current, total: limit }
    }
  } catch {}
  return { used: os.totalmem() - os.freemem(), total: os.totalmem() }
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(1)
}

async function diskStats() {
  const { bavail, bsize, blocks } = await fs.statfs(REPO_ROOT)
  const total = Number(blocks) * Number(bsize)
  const free = Number(bavail) * Number(bsize)
  return { total, free, percent: percent(total - free, total) }
}

async function baileysVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'node_modules', 'baileys', 'package.json'), 'utf8'))
    return pkg.version || 'N/D'
  } catch {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'))
      return pkg.dependencies?.baileys?.replace(/^[^0-9]*/, '') || 'N/D'
    } catch { return 'N/D' }
  }
}

async function sendHost({ msg, sock }) {
  const started = performance.now()
  try {
    const [cpu, memory, disk, baileys, image] = await Promise.all([
      cpuPercent(), memoryStats(), diskStats(), baileysVersion(), fs.readFile(IMAGE_PATH),
    ])
    const ping = Math.round(performance.now() - started)
    const cpuBar = bar(cpu)
    const ramPercent = percent(memory.used, memory.total)
    const ramBar = bar(ramPercent)
    const diskBar = bar(disk.percent)
    const pluginsCount = Object.keys(global.plugins || {}).length
    const ramTotal = gb(memory.total)
    const ramUsed = gb(memory.used)
    const diskFree = gb(disk.free)
    const botRam = (process.memoryUsage().rss / 1024 ** 2).toFixed(0)
    const uptime = formatUptime(process.uptime())
    const statusMessage = `*💙 𝗥𝗘𝗠 𝗛𝗢𝗦𝗧 · 𝗗𝗶𝗮𝗴𝗻ó𝘀𝘁𝗶𝗰𝗼 🧸*
━━━━━━━━━━━━━━━━━━━━
🔮 *𝗘𝗦𝗧𝗔𝗗𝗢*
📡 ᴄᴏɴᴇxɪóɴ  · *Estable* 🩵
⚡ ᴘɪɴɢ      · *${ping} ms* 🟡
🗄️ ᴅʙ        · *N/D* ⚪
⏳ ᴀᴄᴛɪᴠᴏ    · *${uptime}*

☕ *𝗥𝗘𝗖𝗨𝗥𝗦𝗢𝗦*
⚙️ ᴄᴘᴜ   · ${cpuBar} *${cpu}%*
🧊 ʀᴀᴍ   · ${ramBar} *${ramPercent}%* (${ramUsed}/${ramTotal} GB)
💾 ᴅɪsᴄᴏ · ${diskBar} *${disk.percent}%* (${diskFree} GB libres)
🗑️ ᴛᴇᴍᴘ  · *N/D*
🪄 ʀᴇᴍ   · *${botRam} MB*

🔮 *𝗦𝗜𝗦𝗧𝗘𝗠𝗔*
🔌 ᴘʟᴜɢɪɴs   · *${pluginsCount}*
⚙️ ᴍᴏᴅᴏ      · *Público*
📦 ᴄᴏʀᴇ      · *Baileys v${baileys}*
🛠️ ᴛᴏᴏʟs     · *N/D* ✨
━━━━━━━━━━━━━━━━━━━━
_💙 ʀᴇᴍ ᴇsᴛá ʟɪsᴛᴀ ᴘᴀʀᴀ sᴇʀᴠɪʀᴛᴇ._`

    if (sock?.sendMessage) {
      await sock.sendMessage(msg.chat, { image, caption: statusMessage })
    } else {
      await msg.reply(statusMessage)
    }
  } catch (error) {
    console.error('[host] error:', error?.stack || error)
    await msg.reply('❎ No pude generar el diagnóstico del host. Comprueba que el archivo assets/rem-host.png esté disponible.')
  }
}

export default {
  command: 'host',
  category: 'general',
  description: 'Muestra el diagnóstico del host con métricas del sistema.',
  run: sendHost,
}
