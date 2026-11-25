// help.js — Menú de comandos de RemBot-MD, al estilo Rem.
// Estilo del ejemplo de CID (bot tipo Neko/Zhu Yuan): saludo "¡𝐇𝐨𝐥𝐚! 𝐒𝐨𝐲
// 𝐑𝐞𝐦", caja de info con ✐ ꒷ꕤ💎ദ, secciones "» ˚୨•(=^●ω●^=)• ⊹",
// comandos con todos sus alias en negrita y su descripción en "> ...".
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
// una sola vez, con todos sus alias (en el orden en que se registraron).
function collectCommands() {
  const byPlugin = new Map()
  for (const [name, data] of global.comandos || []) {
    const key = data.pluginKey || name
    if (!byPlugin.has(key)) {
      byPlugin.set(key, { names: [], category: data.category || 'general', description: data.description || '', isOwner: !!data.isOwner })
    }
    byPlugin.get(key).names.push(name)
  }
  const groups = new Map()
  for (const entry of byPlugin.values()) {
    const category = String(entry.category || 'general').toLowerCase()
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(entry)
  }
  for (const list of groups.values()) list.sort((a, b) => a.names[0].localeCompare(b.names[0]))
  return groups
}

// Separa la descripción de un plugin de su "Uso: ...": la descripción va
// en la línea "> ..." del menú y los argumentos (entre <>, [] o @) van
// en cursiva junto a los alias del comando.
function splitUsage(description = '') {
  const text = String(description).trim().replace(/\s+/g, ' ')
  const match = text.match(/^(.*?)\s*Uso:\s*(.+)$/i)
  if (!match) return { desc: text, args: '' }
  const desc = match[1].trim()
  const usage = match[2].trim().replace(/`+/g, '').replace(/\.$/, '')
  const head = usage.split('|')[0].trim().split(' / ')[0].trim()
  const bracket = head.match(/<[^>]+>|\[[^\]]+\]/)
  const at = head.match(/@\S+/)
  let args = ''
  if (bracket) args = (at && at.index < bracket.index ? `${at[0]} ` : '') + bracket[0]
  else if (at) args = at[0]
  else {
    const words = head.split(/\s+/).filter(Boolean)
    if (words.length > 1) args = words[1].startsWith('-') ? words[1] : words.slice(1, 3).join(' ')
  }
  return { desc, args: args.slice(0, 30) }
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

// Frase que acompaña a cada categoría en el menú:
// "Comandos de *DESCARGAS* para descargar archivos de varias fuentes."
const CATEGORY_DESCRIPTIONS = {
  main: 'del bot.',
  downloads: 'para descargar archivos de varias fuentes.',
  group: 'para administradores de grupos.',
  socket: 'para configurar el bot.',
  stickers: 'para crear y gestionar stickers.',
  owner: 'exclusivos del dueño.',
  general: 'para el día a día del bot.',
  tools: 'útiles para el día a día.',
  anime: 'de reacciones de anime.',
  video: 'de video.',
}

function categoryLabel(category) {
  return CATEGORY_LABELS[String(category).toLowerCase()] || String(category).toUpperCase()
}

function categoryDescription(category) {
  return CATEGORY_DESCRIPTIONS[String(category).toLowerCase()] || 'del bot.'
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
          return msg.reply(`🌸 *¡Esa categoría no existe!* 💙\n\nCategorías disponibles: *${available}*.\n\nPara ver todo escribe *${prefix}menu* y para filtrar *${prefix}menu <categoría>*. Ejemplo: *${prefix}menu grupo*`)
        }
        categories = [found]
      }

      const header = `¡𝐇𝐨𝐥𝐚! 𝐒𝐨𝐲 𝐑𝐞𝐦 (*${botName}*)
ᴀǫᴜɪ ᴛɪᴇɴᴇs ʟᴀ ʟɪsᴛᴀ ᴅᴇ ᴄᴏᴍᴀɴᴅᴏs
╭┈ ↷
│ ✐ 𝓓𝓮𝓿𝓮𝓵𝓸𝓹𝓮𝓭 𝓫𝔂 Jhon 𝗖𝗜𝗗 💙
│ ✐ ꒷ꕤ💎ദ ᴄᴏᴍᴀɴᴅᴏs ෴ *${total}*
│ ✐ ꒷ꕤ💎ദ ᴘʀᴇғɪᴊᴏ ෴ ${prefix}
│ ✐ ꒷ꕤ💎ദ ᴅᴜᴇñᴏ ෴ *${ownerLine}*
│ ✐ ꒷ꕤ💎ദ ᴛɪᴇᴍᴘᴏ ᴀᴄᴛɪᴠᴏ ෴ *${formatUptime(process.uptime())}*
│ ✐ ꒷ꕤ💎ദ ғᴇᴄʜᴀ ෴ *${DATE_FORMAT.format(now)} · ${TIME_FORMAT.format(now)}* (Lima)${settings.link ? `\n│ ✐ ꒷ꕤ💎ദ ᴇɴʟᴀᴄᴇ ෴ ${settings.link}` : ''}${settings.channelName ? `\n│ ✐ ꒷ꕤ💎ദ ᴄᴀɴᴀʟ ෴ *${settings.channelName}*` : ''}${settings.status ? `\n│ ✐ ꒷ꕤ💎ദ ᴇsᴛᴀᴅᴏ ෴ *${settings.status}*` : ''}
╰─────────────────`

      const sections = categories.map(category => {
        const label = categoryLabel(category)
        const blocks = groups.get(category).map(entry => {
          const { desc, args } = splitUsage(entry.description)
          const aliases = entry.names.map(n => `*${prefix}${n}*`).join(' ')
          const mark = entry.isOwner ? ' 👑' : ''
          const argsPart = args ? ` _${args}_` : ''
          const descPart = desc ? `\n> ${shortDescription(desc)}` : ''
          return `✧ ${aliases}${mark}${argsPart}${descPart}`
        })
        return `» ˚୨•(=^●ω●^=)• ⊹ \`${label}\` ⊹\n> ✐ Comandos *${label}* ${categoryDescription(category)}\n\n${blocks.join('\n\n')}`
      })

      const footer = `🌸・┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈・🌸
_💙 Escribe *${prefix}menu <categoría>* para ver solo una categoría._
_🌸 Ejemplo: *${prefix}menu grupo* · *${prefix}menu descargas*_`
      await sendMenu({ msg, sock, text: `${header}\n\n${sections.join('\n\n')}\n\n${footer}` })
    } catch (error) {
      console.error('[menu] error:', error?.stack || error)
      await msg.reply('❎ No pude generar el menú. Inténtalo de nuevo.')
    }
  },
}
