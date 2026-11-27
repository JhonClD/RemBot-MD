// torrent.js — Descargar un torrent (enlace magnet o archivo .torrent)
// con aria2c y enviar sus archivos por WhatsApp.
// Autor: Jhon 𝗖𝗜𝗗. aria2c es el cliente BitTorrent más rápido: se usa el
// binario del sistema si existe, y si no se baja el binario estático
// (aria2-next 3.1.1, musl, un solo archivo, sin descomprimir) a
// lib/aria2c la primera vez, con el mismo patrón que yt-dlp (descarga
// atómica, comprobación ELF y --version). No se queda sembrando
// (--seed-time=0) y no añade ninguna dependencia npm.

import axios from 'axios'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BOT_ROOT = path.resolve(__dirname, '..', '..')

const EXT_MIME = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.opus': 'audio/opus', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.apk': 'application/vnd.android.package-archive',
  '.txt': 'text/plain', '.srt': 'text/plain', '.ass': 'text/plain',
  '.epub': 'application/epub+zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function mimeFor(ext) {
  return EXT_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream'
}

// aria2-next 3.1.1: binario suelto para Linux (musl estático, sirve en
// glibc y en musl/Alpine). Verificado: el asset existe y pesa ~18 MB.
const ARIA2_VERSION = '3.1.1'
const ARIA2_ASSET = process.arch === 'arm64'
  ? `aria2-next-${ARIA2_VERSION}-linux-aarch64`
  : `aria2-next-${ARIA2_VERSION}-linux-x86_64`
const ARIA2_URLS = [
  `https://github.com/AnInsomniacy/aria2-next/releases/download/v${ARIA2_VERSION}/${ARIA2_ASSET}`,
  `https://github.com/AnInsomniacy/aria2-next/releases/latest/download/${ARIA2_ASSET}`,
]
const ARIA2_PATH = path.join(BOT_ROOT, 'lib', 'aria2c')

// Límite: 2 GB por archivo (máximo que WhatsApp acepta por documento).
const MAX_SIZE = 2 * 1024 * 1024 * 1024
// Tope total del torrent: protege el disco del host (50 GB).
const MAX_TOTAL = 10 * 1024 * 1024 * 1024
// Máximo de archivos que se envían de un mismo torrent.
const MAX_FILES = 10
// Tiempo máximo de descarga completa. --bt-stop-timeout=120 ya corta
// antes un torrent sin semillas (2 min a velocidad 0).
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

function formatBytes(bytes = 0) {
  if (!bytes || Number.isNaN(bytes)) return 'Desconocido'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = Number(bytes)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

function cleanText(x) {
  return String(x || '').replace(/\s+/g, ' ').trim()
}

// Tamaños que imprime aria2c: "0B", "800KiB", "1.2MiB", "3.4GiB".
function parseAriaSize(text) {
  if (!text) return null
  const m = String(text).trim().match(/^([\d.,]+)\s*([KMGT]?i?B)$/i)
  if (!m) return null
  const value = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  const mult = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4 }
  return Math.round(value * (mult[m[2].toUpperCase()] || 1))
}

function isMagnet(s) {
  return /^magnet:\?xt=urn:btih:[a-zA-Z0-9]+/i.test(cleanText(s))
}

function isTorrentUrl(s) {
  return /^https?:\/\/.+/i.test(cleanText(s))
}

function btihShort(magnet) {
  const m = cleanText(magnet).match(/btih:([a-zA-Z0-9]+)/i)
  return m ? m[1].slice(0, 8) : null
}

// Prepara aria2c: usa el del sistema si existe, si no baja el binario
// estático a lib/aria2c (mismo patrón que yt-dlp en ytmp3.js).
const aria2State = globalThis.__rembotAria2State ??= { verifiedPath: null, initPromise: null }

async function ensureAria2c() {
  if (aria2State.verifiedPath) return aria2State.verifiedPath
  if (aria2State.initPromise) return aria2State.initPromise

  aria2State.initPromise = (async () => {
    for (const candidate of [ARIA2_PATH, 'aria2c']) {
      try {
        if (candidate === ARIA2_PATH) await fsp.access(candidate, fs.constants.X_OK)
        await execFileAsync(candidate, ['--version'], { timeout: 15000 })
        aria2State.verifiedPath = candidate
        return candidate
      } catch {}
    }

    let lastError = null
    for (const url of ARIA2_URLS) {
      const tmpBin = `${ARIA2_PATH}.tmp.${process.pid}.${Date.now()}`
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length < 1_000_000 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
          throw new Error('El archivo descargado no es un binario ELF válido.')
        }
        await fsp.mkdir(path.dirname(ARIA2_PATH), { recursive: true })
        await fsp.writeFile(tmpBin, buffer, { mode: 0o755 })
        await fsp.rename(tmpBin, ARIA2_PATH)
        await execFileAsync(ARIA2_PATH, ['--version'], { timeout: 15000 })
        aria2State.verifiedPath = ARIA2_PATH
        return ARIA2_PATH
      } catch (error) {
        lastError = error
        await fsp.rm(tmpBin, { force: true }).catch(() => {})
      }
    }
    throw new Error(`No pude preparar aria2c: ${lastError?.message || 'descarga fallida'}.`)
  })().finally(() => {
    aria2State.initPromise = null
  })

  return aria2State.initPromise
}

// Baja un archivo .torrent desde una URL y comprueba que sea un torrent
// (los archivos .torrent son bencode: empiezan con 'd').
async function fetchTorrentBuffer(url) {
  const res = await axios.get(cleanText(url), {
    timeout: 30000,
    maxRedirects: 5,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    validateStatus: () => true,
  })
  if (res.status < 200 || res.status >= 400) {
    throw new Error(`No pude bajar ese archivo .torrent (HTTP ${res.status}).`)
  }
  const buf = Buffer.from(res.data || [])
  if (!buf.length || buf[0] !== 0x64) {
    throw new Error('Ese enlace no es un archivo .torrent válido.')
  }
  return buf
}

// Decodificador bencode mínimo (sin dependencias): lee la lista de
// archivos y sus tamaños exactos de un .torrent. Devuelve [{ rel, size }].
// Si el archivo no se puede leer, devuelve [] y la descarga sigue con
// los topes de seguridad del progreso y del envío.
function bdecode(buf, pos = { i: 0 }) {
  const c = String.fromCharCode(buf[pos.i])
  if (c === 'i') {
    const end = buf.indexOf(0x65, pos.i)
    const n = Number(buf.subarray(pos.i + 1, end).toString())
    pos.i = end + 1
    return n
  }
  if (c === 'l') {
    pos.i++
    const out = []
    while (String.fromCharCode(buf[pos.i]) !== 'e') out.push(bdecode(buf, pos))
    pos.i++
    return out
  }
  if (c === 'd') {
    pos.i++
    const out = {}
    while (String.fromCharCode(buf[pos.i]) !== 'e') {
      const k = bdecode(buf, pos)
      out[k] = bdecode(buf, pos)
    }
    pos.i++
    return out
  }
  const colon = buf.indexOf(0x3a, pos.i)
  const len = Number(buf.subarray(pos.i, colon).toString())
  const start = colon + 1
  const s = buf.subarray(start, start + len)
  pos.i = start + len
  return s
}

function bufText(x) {
  return Buffer.isBuffer(x) ? x.toString('utf8') : String(x ?? '')
}

function parseTorrentFile(buf) {
  try {
    const data = bdecode(Buffer.from(buf))
    const info = data?.info
    if (!info || typeof info !== 'object') return []
    const name = bufText(info.name) || 'torrent'
    if (typeof info.length === 'number') return [{ rel: name, size: info.length }]
    if (Array.isArray(info.files)) {
      return info.files.map(f => ({
        rel: [name, ...(Array.isArray(f.path) ? f.path.map(p => bufText(p)) : [])].join('/'),
        size: typeof f.length === 'number' ? f.length : null,
      }))
    }
    return []
  } catch {
    return []
  }
}

// Recorre una carpeta y devuelve sus archivos (sin controles .aria2
// ni el .torrent de origen). Comprueba que nada se salga de la carpeta.
async function walkFiles(dir) {
  const out = []
  async function walk(current) {
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.aria2') || entry.name.endsWith('.torrent')) continue
      const resolved = path.resolve(full)
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) continue
      try {
        const stat = await fsp.stat(resolved)
        out.push({ filePath: resolved, rel: path.relative(dir, resolved), size: stat.size })
      } catch {}
    }
  }
  await walk(dir)
  return out
}

export default {
  command: ['torrent', 'magnet'],
  category: 'downloads',
  description: 'Descarga un torrent (magnet o .torrent) con aria2c y envía sus archivos. Uso: `torrent <enlace magnet o URL .torrent>`.',
  run: async ({ msg, sock, usedPrefix, text }) => {
    const input = cleanText(text)
    if (!input) {
      return msg.reply(`*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n> ✐ ᴜsᴏ » *${usedPrefix}torrent <enlace magnet o URL .torrent>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}torrent magnet:?xt=urn:btih:abc123..._`)
    }
    if (!isMagnet(input) && !isTorrentUrl(input)) {
      return msg.reply('*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n> ✖ ᴇʀʀᴏʀ » *Eso no es un enlace magnet ni una URL .torrent. Pega el magnet que empieza con magnet:?xt=urn:btih:...*')
    }

    await msg.react?.('⏳').catch(() => {})

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rembot-torrent-'))
    let child = null
    let statusMsg = null
    let statusEditOk = true
    let lastPct = -1
    let displayName = 'torrent'
    let totalBytes = 0

    const progressText = (pct, downloaded, total, speed, seeds) => {
      let info = '*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n'
      info += `> ❀ ɴᴏᴍʙʀᴇ » *${displayName}*\n`
      info += `> ✰ ᴘʀᴏɢʀᴇsᴏ » *${pct}%* │ ❒ *${formatBytes(downloaded)} / ${formatBytes(total)}*\n`
      info += `> ✰ ᴠᴇʟᴏᴄɪᴅᴀᴅ » *${formatBytes(speed)}/s*`
      if (seeds != null) info += ` │ ✧ *${seeds} semillas*`
      return info
    }

    try {
      const aria2c = await ensureAria2c()

      // Origen: magnet directo, o .torrent bajado a un archivo.
      let source = input
      let listed = []
      if (isTorrentUrl(input)) {
        const buf = await fetchTorrentBuffer(input)
        // Con .torrent se conocen nombre y tamaños antes de bajar
        // (se lee el propio archivo, no hace falta aria2c para esto).
        listed = parseTorrentFile(buf)
        const torrentFile = path.join(tmpDir, 'fuente.torrent')
        await fsp.writeFile(torrentFile, buf)
        source = torrentFile
      } else {
        const short = btihShort(input)
        if (short) displayName = `torrent ${short}…`
      }

      if (listed.length) {
        const total = listed.reduce((acc, f) => acc + (f.size || 0), 0)
        const tooBig = listed.find(f => (f.size || 0) > MAX_SIZE)
        if (total > MAX_TOTAL) {
          throw new Error(`Ese torrent pesa ${formatBytes(total)} y supera el tope total de 10 GB.`)
        }
        if (tooBig) {
          throw new Error(`El archivo "${path.basename(tooBig.rel)}" pesa ${formatBytes(tooBig.size)} y supera el límite de WhatsApp para documentos (2 GB).`)
        }
        totalBytes = total
        displayName = listed.length === 1
          ? path.basename(listed[0].rel)
          : (listed[0].rel.split('/')[0] || 'torrent')
        let info = '*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n'
        info += `> ❀ ɴᴏᴍʙʀᴇ » *${displayName}*\n`
        info += `> ❒ ᴘᴇsᴏ » *${formatBytes(total)}*\n`
        info += `> ⊞ ᴀʀᴄʜɪᴠᴏs » *${listed.length}*`
        await sock.sendMessage(msg.chat, { text: info }, { quoted: msg })
      }

      statusMsg = await sock.sendMessage(msg.chat, { text: progressText(0, 0, totalBytes, 0, null) }, { quoted: msg })

      // Descarga con aria2c. Sin semilla al terminar, corta a los 2 min
      // sin velocidad y con progreso cada 5 segundos.
      const args = [
        `--dir=${tmpDir}`,
        '--seed-time=0',
        '--bt-stop-timeout=120',
        '--summary-interval=5',
        '--file-allocation=none',
        '--allow-overwrite=true',
        '--auto-file-renaming=false',
        source,
      ]
      const exitCode = await new Promise((resolve, reject) => {
        let settled = false
        let tail = ''
        const finish = (value, error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        }
        const timer = setTimeout(() => {
          try { child?.kill('SIGKILL') } catch {}
          finish(null, new Error('La descarga tardó más de 15 minutos, puede que tenga pocas semillas. Inténtalo más tarde.'))
        }, DOWNLOAD_TIMEOUT_MS)

        try {
          child = spawn(aria2c, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          finish(null, error)
          return
        }

        const onChunk = (chunk) => {
          const text = String(chunk || '')
          tail = (tail + text).slice(-2000)
          // Las líneas de progreso usan \r al estar canalizadas.
          for (const line of text.split(/[\r\n]+/)) {
            const m = line.match(/\[#[0-9a-f]+\s+([\d.]+[KMGT]?i?B)\/([\d.]+[KMGT]?i?B)\((\d+)%\)[^\]]*DL:([\d.]+[KMGT]?i?B)/i)
            if (!m) continue
            const downloaded = parseAriaSize(m[1]) ?? 0
            const total = parseAriaSize(m[2]) ?? 0
            const pct = Number(m[3]) || 0
            const speed = parseAriaSize(m[4]) ?? 0
            if (total > 0) totalBytes = total
            if (totalBytes > MAX_TOTAL) {
              try { child?.kill('SIGKILL') } catch {}
              finish(null, new Error(`Ese torrent pesa ${formatBytes(totalBytes)} y supera el tope total de 10 GB.`))
              return
            }
            const seedsMatch = line.match(/\bSD:(\d+)/)
            const seeds = seedsMatch ? Number(seedsMatch[1]) : null
            if (pct >= lastPct + 20 && pct < 100) {
              lastPct = pct
              if (statusEditOk && statusMsg?.key) {
                sock.sendMessage(msg.chat, { text: progressText(pct, downloaded, totalBytes, speed, seeds), edit: statusMsg.key })
                  .catch(() => { statusEditOk = false })
              }
            }
          }
        }
        child.stdout?.on('data', onChunk)
        child.stderr?.on('data', onChunk)
        child.once('error', (error) => finish(null, new Error(`No pude ejecutar aria2c: ${error?.message || error}`)))
        child.once('close', (code) => {
          if (code === 0) finish(0)
          else finish(null, new Error(`aria2c terminó con error (código ${code}). ${cleanText(tail.replace(/\[#[^\]]*\]/g, '').slice(-300)) || 'Sin más detalle.'}`))
        })
      })

      if (exitCode !== 0) throw new Error('La descarga no terminó bien.')

      // Envía cada archivo como documento (máx. 10, máx. 2 GB cada uno).
      const files = await walkFiles(tmpDir)
      const sendable = files.filter(f => (f.size || 0) <= MAX_SIZE).slice(0, MAX_FILES)
      const skipped = files.length - sendable.length
      let sent = 0
      for (const file of sendable) {
        const name = path.basename(file.rel) || displayName
        const caption = `*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n> ❀ ɴᴏᴍʙʀᴇ » *${name}*\n> ❒ ᴘᴇsᴏ » *${formatBytes(file.size)}*`
        try {
          await sock.sendMessage(msg.chat, {
            document: { url: file.filePath },
            mimetype: mimeFor(path.extname(name)),
            fileName: name,
            caption,
            mentions: [msg.sender],
          }, { quoted: msg })
          sent++
        } catch (error) {
          console.error('[torrent] no se pudo enviar', name, error?.message || error)
        }
      }
      if (!sent) {
        throw new Error('Se descargó, pero no pude enviar ningún archivo por WhatsApp.')
      }
      if (skipped > 0) {
        await msg.reply(`*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n> ✖ ᴇʀʀᴏʀ » *${skipped} archivo(s) no se enviaron: pesan más de 2 GB o pasan del límite de 10 por torrent.*`)
      }
      await msg.react?.('✅').catch(() => {})
    } catch (error) {
      console.error('[torrent] error:', error?.stack || error)
      await msg.react?.('❌').catch(() => {})
      await msg.reply(`*「✦」 𝗧𝗢𝗥𝗥𝗘𝗡𝗧*\n> ✖ ᴇʀʀᴏʀ » *${error?.message || 'No pude descargar ese torrent. Inténtalo más tarde.'}*`)
    } finally {
      try { child?.kill('SIGKILL') } catch {}
      try { await fsp.rm(tmpDir, { recursive: true, force: true }) } catch {}
    }
  },
}
