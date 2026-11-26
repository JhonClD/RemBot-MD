// ytmp4.js — Descargar el video (MP4) de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs de terceros: busca con yt-search (scraping)
// y descarga con yt-dlp (scrapea YouTube directo, sin API key).
// yt-dlp es un binario que se descarga solo a lib/yt-dlp la primera
// vez (desde GitHub, versión fijada + fallback a latest) y se reutiliza.
// OJO: tiene que ser el asset yt-dlp_linux (ELF standalone). El asset
// yt-dlp a secas es un script de Python (zipapp): falla la validación
// ELF y el contenedor no tiene Python para ejecutarlo.
// Fallbacks de descarga: 1) yt-dlp 360p, 2) yt-dlp con cliente Android,
// 3) yt-dlp 480p. Videos de más de 50 MB se mandan como documento;
// más de 100 MB no se mandan (límite del comando).
// Requiere: yt-search, play-dl (solo como info de respaldo), ffmpeg
// en el servidor para unir video+audio (ya lo usa el bot).

import yts from 'yt-search'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const YTDLP_VERSION = '2026.11.23'
const YTDLP_URLS = [
  `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux`,
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
]
const YTDLP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'yt-dlp')
const COOKIES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'cookies.txt')
// Si existe lib/cookies.txt (cookies de YouTube exportadas), yt-dlp
// las usa: es la forma de pasar el "Sign in to confirm you're not a bot"
// cuando YouTube bloquea la IP del servidor. Sin el archivo, no cambia nada.
async function cookieArgs() {
  try { await fs.access(COOKIES_PATH); return ['--cookies', COOKIES_PATH] } catch { return [] }
}
const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50 MB: por encima, documento
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB: límite del comando

const isYTUrl = url =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i.test(url || '')

function getVideoId(text = '') {
  const raw = String(text || '').trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw
  return raw.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/)|[?&]v=)([a-zA-Z0-9_-]{11})/,
  )?.[1] || null
}

// Límite de tiempo para no quedarse colgado: YouTube a veces deja la
// conexión sin responder desde la IP del servidor y sin esto el comando
// se queda congelado sin mandar ni error.
function withTimeout(promise, ms, errorMessage) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(errorMessage || `La operación tardó demasiado (${Math.round(ms / 1000)}s).`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function getVideoMeta(input) {
  const id = getVideoId(input)
  if (id) {
    try {
      const info = await withTimeout(yts({ videoId: id }), 25000, 'YouTube no responde a la búsqueda desde el servidor. Prueba con el enlace directo del video.')
      if (info?.videoId) return { url: `https://youtu.be/${info.videoId}`, title: info.title, channel: info.author?.name || info.author, duration: info.timestamp, views: info.views, thumbnail: info.thumbnail || info.image }
    } catch {}
    // Con enlace directo no hace falta la búsqueda: se descarga con la URL.
    return { url: `https://youtu.be/${id}`, title: null, channel: null, duration: null, views: null, thumbnail: null }
  }
  const search = await withTimeout(yts(input), 25000, 'YouTube no responde a la búsqueda desde el servidor. Prueba con el enlace directo del video.')
  const video = search.videos?.[0] || search.all?.find(v => v.type === 'video')
  if (!video?.url) throw new Error('No encontré un video válido de YouTube para eso.')
  return { url: video.url, title: video.title, channel: video.author?.name || video.author, duration: video.timestamp, views: video.views, thumbnail: video.thumbnail || video.image }
}

// Descarga el binario de yt-dlp si no está (o no ejecuta).
async function ensureYtDlp() {
  try {
    await fs.access(YTDLP_PATH, fs.constants.X_OK)
    await execFileAsync(YTDLP_PATH, ['--version'], { timeout: 15000 })
    return YTDLP_PATH
  } catch {}
  let lastError = null
  for (const url of YTDLP_URLS) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length < 1_000_000 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        throw new Error('El archivo descargado no es un binario válido.')
      }
      await fs.mkdir(path.dirname(YTDLP_PATH), { recursive: true })
      await fs.writeFile(YTDLP_PATH, buffer, { mode: 0o755 })
      await execFileAsync(YTDLP_PATH, ['--version'], { timeout: 15000 })
      return YTDLP_PATH
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`No pude preparar yt-dlp: ${lastError?.message || 'descarga fallida'}.`)
}

async function downloadWithYtDlp(ytdlp, url, tmpDir, format, extraArgs = []) {
  const outTemplate = path.join(tmpDir, 'video.%(ext)s')
  const cookies = await cookieArgs()
  await execFileAsync(ytdlp, [
    '-f', format,
    '--merge-output-format', 'mp4',
    '--js-runtimes', 'node',
    '--no-playlist', '--no-warnings',
    ...cookies,
    ...extraArgs,
    '-o', outTemplate,
    url,
  ], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 })
  const files = (await fs.readdir(tmpDir)).filter(f => f.startsWith('video.'))
  const file = files.find(f => f.endsWith('.mp4')) || files[0]
  if (!file) throw new Error('yt-dlp terminó sin dejar el video.')
  const filePath = path.join(tmpDir, file)
  const stat = await fs.stat(filePath)
  if (stat.size === 0) throw new Error('yt-dlp dejó el video vacío.')
  if (stat.size > MAX_FILE_SIZE) throw new Error(`El video pesa ${(stat.size / 1024 / 1024).toFixed(1)} MB, más del límite de 100 MB.`)
  return { filePath, size: stat.size }
}

async function getVideo(url) {
  const errors = []
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-play2-'))
  try {
    const ytdlp = await ensureYtDlp()
    const attempts = [
      ['bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360][ext=mp4]/b[height<=360]', []],
      ['bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360][ext=mp4]/b[height<=360]', ['--extractor-args', 'youtube:player_client=android,web']],
      ['bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360][ext=mp4]/b[height<=360]', ['--extractor-args', 'youtube:player_client=ios']],
      ['bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360][ext=mp4]/b[height<=360]', ['--extractor-args', 'youtube:player_client=tv_embedded']],
      ['bv*[height<=480]+ba/b[height<=480]', []],
    ]
    for (const [format, extra] of attempts) {
      try {
        return await downloadWithYtDlp(ytdlp, url, tmpDir, format, extra)
      } catch (error) {
        errors.push(`${format.slice(0, 20)}…: ${error.message}`)
      }
    }
    throw new Error(`No pude descargar el video (${errors.join(' | ')}).`)
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function getThumbnail(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
  if (!res.ok) return null
  const buffer = Buffer.from(await res.arrayBuffer())
  return buffer.length ? buffer : null
}

function sanitizeFileName(name = 'video') {
  return String(name)
    .replace(/\.(mp4|mkv|webm|mov|avi)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video'
}

function formatBytes(bytes = 0) {
  if (!bytes || Number.isNaN(bytes)) return 'Desconocido'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = Number(bytes)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

export default {
  command: ['play2', 'mp4', 'ytmp4', 'ytvideo', 'playvideo'],
  category: 'downloads',
  description: 'Descarga el video de YouTube. Uso: `play2 <nombre o enlace>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args?.[0]) {
      return msg.reply(`Escribe el nombre del video o pega su enlace.\nEjemplo: *${usedPrefix}play2 despacito*`)
    }
    const input = args.join(' ').trim()
    let tmpDir = null
    try {
      const meta = await getVideoMeta(input)
      const url = meta.url
      const title = meta.title || 'video'
      const fileName = `${sanitizeFileName(title)}.mp4`
      const infoMessage = `*Descargando video:* ${title}\n\n*Canal:* ${meta.channel || 'Desconocido'}\n*Duración:* ${meta.duration || 'Desconocida'}\n*Vistas:* ${Number(meta.views || 0).toLocaleString('es-PE')}\n*Calidad:* 360p\n*Enlace:* ${url}`
      if (meta.title) {
        try {
          if (meta.thumbnail) {
            await withTimeout(sock.sendMessage(msg.chat, { image: { url: meta.thumbnail }, caption: infoMessage }, { quoted: msg }), 20000, 'La tarjeta de info no se pudo enviar.')
          } else {
            await msg.reply(infoMessage)
          }
        } catch (error) {
          console.error('[play2] no pude mandar la tarjeta:', error?.message || error)
        }
      }
      const { filePath, size } = await getVideo(url)
      tmpDir = path.dirname(filePath)
      const sizeText = formatBytes(size)
      const sendAsDocument = size > MAX_VIDEO_SIZE
      const caption = `*${title}*\n\n*Canal:* ${meta.channel || 'Desconocido'}\n*Calidad:* 360p\n*Tamaño:* ${sizeText}`
      const buffer = await fs.readFile(filePath)
      if (sendAsDocument) {
        await sock.sendMessage(msg.chat, { document: buffer, mimetype: 'video/mp4', fileName, caption }, { quoted: msg })
      } else {
        try {
          await sock.sendMessage(msg.chat, {
            video: buffer,
            mimetype: 'video/mp4',
            fileName,
            caption,
            ...(meta.thumbnail ? { jpegThumbnail: await getThumbnail(meta.thumbnail).catch(() => null) } : {}),
          }, { quoted: msg })
        } catch {
          await sock.sendMessage(msg.chat, { document: buffer, mimetype: 'video/mp4', fileName, caption }, { quoted: msg })
        }
      }
    } catch (error) {
      console.error('[play2] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar el video. Inténtalo más tarde.')
    } finally {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  },
}
