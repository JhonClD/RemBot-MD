// help.js — Menú de comandos de RemBot-MD, al estilo Rem.
// Portado de YukiBot-MD (cmds/main/help.js + core/system/commands.js):
// Yuki mostraba un menú estático con arte unicode y variables $prefix/$owner;
// aquí el menú se construye dinámico desde global.comandos (loader
// lib/system/cmdsloader.js), sin moment, sin node-fetch y sin la DB de Yuki.
// El banner y el icono salen del store (lib/system/botstore.js).
// Crédito: Jhon 𝗖𝗜𝗗.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBotSettings, getPrefix } from '../../lib/system/botstore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const DATE_FORMAT = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima',
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
})
const TIME_FORMAT = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

// Normaliza una categoría para comparar: sin tildes, en minúsculas, sin 's' final.
function normalize(text = '') {
  const clean = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
  return clean.endsWith('s') ? clean.slice(0, -1) : clean
}

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

function shortDescription(description = '') {
  const text = String(description).trim().replace(/\s+/g, ' ')
  if (text.length <= 120) return text
  return `${text.slice(0, 117).trimEnd()}…`
}

// Agrupa global.comandos por categoría; un plugin con varios alias aparece
// una sola vez, con su primer comando como nombre principal.
function collectCommands() {
  const byPlugin = new Map()
  for (const [name, data] of global.comandos || []) {
    const key = data.pluginKey || name
    if (!byPlugin.has(key)) {
      byPlugin.set(key, { name, category: data.category || 'general', description: data.description || '', isOwner: !!data.isOwner })
    }
  }
  const groups = new Map()
  for (const entry of byPlugin.values()) {
    const category = String(entry.category || 'general').toLowerCase()
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(entry)
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return groups
}

const CATEGORY_ALIASES = {
  grupo: 'grupo',
  group: 'grupo',
  descarga: 'descargas',
  download: 'descargas',
  sticker: 'stickers',
  utilidad: 'utils',
  herramienta: 'utils',
  dueno: 'socket',
  owner: 'socket',
  socket: 'socket',
  bot: 'socket',
}

// Nombre en español que muestra el menú para cada categoría (si no está
// aquí, se muestra la clave en mayúsculas).
const CATEGORY_LABELS = {
  main: 'PRINCIPAL',
  downloads: 'DESCARGAS',
  group: 'GRUPO',
  socket: 'AJUSTES DEL BOT',
  stickers: 'STICKERS',
  owner: 'DUEÑO',
  general: 'GENERAL',
  tools: 'HERRAMIENTAS',
  anime: 'ANIME',
  video: 'VIDEO',
}

function categoryLabel(category) {
  return CATEGORY_LABELS[String(category).toLowerCase()] || String(category).toUpperCase()
}

function resolveCategory(input, groups) {
  const wanted = normalize(input)
  if (groups.has(wanted)) return wanted
  const alias = CATEGORY_ALIASES[wanted]
  if (alias && groups.has(alias)) return alias
  for (const category of groups.keys()) {
    if (normalize(category) === wanted) return category
  }
  return null
}

function isVideoBanner(value) {
  return /\.(mp4|webm)(\?|#|$)/i.test(value)
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

// Resuelve el banner/icono del store a algo enviable:
// { video: { url } } | { image: { url } } | { image: Buffer } | null.
async function resolveMedia(value) {
  if (!value) return null
  if (isVideoBanner(value)) return { video: { url: value }, gifPlayback: true }
  if (isHttpUrl(value)) return { image: { url: value } }
  const filePath = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value)
  try {
    const buffer = await fs.readFile(filePath)
    if (isVideoBanner(filePath)) return { video: buffer, gifPlayback: true }
    return { image: buffer }
  } catch {
    return null
  }
}

async function sendMenu({ msg, sock, text }) {
  const settings = getBotSettings()
  const media = await resolveMedia(settings.banner) || await resolveMedia(settings.icon)
  if (sock?.sendMessage) {
    if (media) {
      await sock.sendMessage(msg.chat, { ...media, caption: text }, { quoted: msg })
    } else {
      await sock.sendMessage(msg.chat, { text }, { quoted: msg })
    }
    return
  }
  await msg.reply(text)
}

export default {
  command: ['menu', 'help', 'ayuda', 'allmenu'],
  category: 'main',
  description: 'Muestra el menú de comandos. Usa menu <categoría> para ver solo una categoría.',
  run: async ({ msg, sock, args = [], usedPrefix }) => {
    try {
      const prefix = usedPrefix || getPrefix()
      const settings = getBotSettings()
      const botName = settings.name || 'RemBot-MD'
      const ownerNumber = String(settings.owner || '').split('@')[0].replace(/\D/g, '')
      const ownerLine = ownerNumber ? `Jhon 𝗖𝗜𝗗 (@${ownerNumber})` : 'Jhon 𝗖𝗜𝗗'
      const now = new Date()
      const groups = collectCommands()
      const total = [...groups.values()].reduce((sum, list) => sum + list.length, 0)

      const filter = String(args[0] || '').trim()
      let categories = [...groups.keys()].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
      if (filter) {
        const found = resolveCategory(filter, groups)
        if (!found) {
          const available = [...groups.keys()].sort().join(', ')
          return msg.reply(`❎ La categoría *${filter}* no existe. Categorías disponibles: *${available}*.\n\nPara ver todo escribe *${prefix}menu* y para filtrar *${prefix}menu <categoría>*. Ejemplo: *${prefix}menu grupo*`)
        }
        categories = [found]
      }

      const header = `*💙 𝗥𝗘𝗠𝗕𝗢𝗧-𝗠𝗗 · 𝗠𝗘𝗡Ú 🧸*
━━━━━━━━━━━━━━━━━━━━
🔮 *𝗜𝗡𝗙𝗢*
🤖 ɴᴏᴍʙʀᴇ   · *${botName}*
👑 ᴅᴜᴇñᴏ   · *${ownerLine}*
⌨️ ᴘʀᴇғɪᴊᴏ  · *${prefix}*
⏳ ᴀᴄᴛɪᴠᴏ   · *${formatUptime(process.uptime())}*
📅 ғᴇᴄʜᴀ   · *${DATE_FORMAT.format(now)}*
🕐 ʜᴏʀᴀ    · *${TIME_FORMAT.format(now)}* (Lima)
📋 ᴄᴏᴍᴀɴᴅᴏs · *${total}*${settings.link ? `\n🔗 ᴇɴʟᴀᴄᴇ  · ${settings.link}` : ''}${settings.channelName ? `\n📢 ᴄᴀɴᴀʟ   · *${settings.channelName}*` : ''}${settings.status ? `\n💬 ᴇsᴛᴀᴅᴏ  · *${settings.status}*` : ''}
━━━━━━━━━━━━━━━━━━━━`

      const sections = categories.map(category => {
        const lines = groups.get(category).map(entry => {
          const mark = entry.isOwner ? ' 👑' : ''
          const desc = entry.description ? ` — ${shortDescription(entry.description)}` : ''
          return `▸ *${prefix}${entry.name}*${mark}${desc}`
        })
        return `📂 *${categoryLabel(category)}*\n${lines.join('\n')}`
      })

      const footer = `━━━━━━━━━━━━━━━━━━━━
_💙 Escribe *${prefix}menu <categoría>* para ver solo una categoría._`
      await sendMenu({ msg, sock, text: `${header}\n\n${sections.join('\n\n')}\n\n${footer}` })
    } catch (error) {
      console.error('[menu] error:', error?.stack || error)
      await msg.reply('❎ No pude generar el menú. Inténtalo de nuevo.')
    }
  },
}
