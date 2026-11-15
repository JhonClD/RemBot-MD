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

function bar(value) {
  const filled = Math.max(0, Math.min(BAR_LENGTH, Math.round(value / 100 * BAR_LENGTH)))
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
  const used = Math.max(0, total - free)
  return { total, used, free, percent: percent(used, total) }
}

async function addTreeSize(root, includeFile, result, maxDepth = 6) {
  const pending = [{ dir: root, depth: 0 }]
  while (pending.length && result.files < 5000) {
    const { dir, depth } = pending.pop()
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (result.files >= 5000) break
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) pending.push({ dir: fullPath, depth: depth + 1 })
        continue
      }
      if (!entry.isFile() || !includeFile(fullPath)) continue
      try {
        const stat = await fs.stat(fullPath)
        result.bytes += stat.size
        result.files++
      } catch {}
    }
  }
}

async function tempStats() {
  const result = { bytes: 0, files: 0 }
  const tempRoot = os.tmpdir()
  try {
    const entries = await fs.readdir(tempRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('rembot-dw4-')) {
        await addTreeSize(path.join(tempRoot, entry.name), () => true, result)
      }
    }
  } catch {}
  const exifTempRoot = path.join(REPO_ROOT, 'lib', 'system', path.basename(tempRoot))
  await addTreeSize(exifTempRoot, filePath => ['.jpg', '.webp'].includes(path.extname(filePath).toLowerCase()), result)
  return result
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
    const [cpu, memory, disk, temp, baileys, image] = await Promise.all([
      cpuPercent(), memoryStats(), diskStats(), tempStats(), baileysVersion(), fs.readFile(IMAGE_PATH),
    ])
    const ping = Math.round(performance.now() - started)
    const cpuBar = bar(cpu)
    const ramPercent = percent(memory.used, memory.total)
    const ramBar = bar(ramPercent)
    const diskBar = bar(disk.percent)
    const pluginsCount = Object.keys(global.plugins || {}).length
    const ramTotal = gb(memory.total)
    const ramUsed = gb(memory.used)
    const diskUsed = gb(disk.used)
    const diskTotal = gb(disk.total)
    const diskFree = gb(disk.free)
    const tempMb = (temp.bytes / 1024 ** 2).toFixed(1)
    const botRam = (process.memoryUsage().rss / 1024 ** 2).toFixed(0)
    const uptime = formatUptime(process.uptime())
    const statusMessage = `*💙 𝗥𝗘𝗠 𝗛𝗢𝗦𝗧 · 𝗗𝗶𝗮𝗴𝗻ó𝘀𝘁𝗶𝗰𝗼 🧸*
━━━━━━━━━━━━━━━━━━━━
🔮 *𝗘𝗦𝗧𝗔𝗗𝗢*
📡 ᴄᴏɴᴇxɪóɴ  · *Estable* 🩵
⚡ ᴘɪɴɢ      · *${ping} ms* 🟡
⏳ ᴀᴄᴛɪᴠᴏ    · *${uptime}*

☕ *𝗥𝗘𝗖𝗨𝗥𝗦𝗢𝗦*
⚙️ ᴄᴘᴜ   · ${cpuBar} *${cpu}%*
🧊 ʀᴀᴍ   · ${ramBar} *${ramPercent}%* (${ramUsed}/${ramTotal} GB)
💾 ᴅɪsᴄᴏ · ${diskBar} *${disk.percent}%* (${diskUsed}/${diskTotal} GB usados; ${diskFree} GB libres)
🗑️ ᴛᴇᴍᴘ  · *${tempMb} MB* (${temp.files} archivos temporales del bot)
🪄 ʀᴇᴍ   · *${botRam} MB*

🔮 *𝗦𝗜𝗦𝗧𝗘𝗠𝗔*
🔌 ᴘʟᴜɢɪɴs   · *${pluginsCount}*
⚙️ ᴍᴏᴅᴏ      · *Público*
📦 ᴄᴏʀᴇ      · *Baileys v${baileys}*
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
