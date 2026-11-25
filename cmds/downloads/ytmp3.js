// ytmp3.js — Descargar el audio de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs de terceros: busca con yt-search (scraping)
// y descarga con yt-dlp (scrapea YouTube directo, sin API key).
// yt-dlp es un binario que se descarga solo a bot/lib/yt-dlp la primera
// vez (desde GitHub, versión fijada + fallback a latest) y se reutiliza.
// Fallbacks de descarga: 1) yt-dlp normal, 2) yt-dlp con cliente
// Android, 3) play-dl (scraping). Requiere: yt-search, play-dl.

import yts from 'yt-search'
import play from 'play-dl'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const YTDLP_VERSION = '2026.11.23'
const YTDLP_URLS = [
  `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp`,
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
]
const YTDLP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'yt-dlp')
const MAX_AUDIO_SIZE = 64 * 1024 * 1024 // 64 MB

const isYTUrl = (url = '') =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i.test(url)

function getVideoId(text = '') {
  const raw = String(text || '').trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

async function getVideoInfo(input, videoId) {
  if (videoId) {
    try {
      const info = await yts({ videoId })
      if (info?.videoId) {
        return { ...info, url: `https://youtu.be/${info.videoId}`, image: info.thumbnail || info.image }
      }
    } catch {}
  }
  const search = await yts(input)
  return search.videos?.[0] || search.all?.find(v => v.type === 'video') || null
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

async function downloadWithYtDlp(ytdlp, url, tmpDir, extraArgs = []) {
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s')
  await execFileAsync(ytdlp, [
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--js-runtimes', 'node',
    '--no-playlist', '--no-warnings',
    ...extraArgs,
    '-o', outTemplate,
    url,
  ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 })
  const files = await fs.readdir(tmpDir)
  const file = files.find(f => f.startsWith('audio.'))
  if (!file) throw new Error('yt-dlp terminó sin dejar el audio.')
  const filePath = path.join(tmpDir, file)
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_AUDIO_SIZE) throw new Error(`El audio pesa ${(stat.size / 1024 / 1024).toFixed(1)} MB, más del límite de 64 MB.`)
  if (stat.size === 0) throw new Error('yt-dlp dejó el audio vacío.')
  const buffer = await fs.readFile(filePath)
  const ext = path.extname(file).slice(1).toLowerCase()
  return { buffer, ext, name: file }
}

async function streamToBuffer(stream, maxSize) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > maxSize) throw new Error(`El audio pesa más del límite de 64 MB.`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function sanitizeFileName(name = 'audio') {
  return String(name)
    .replace(/\.(mp3|m4a|webm|opus|ogg)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio'
}

async function getAudio(url, title) {
  const errors = []
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-play-'))
  try {
    // Intento 1 y 2: yt-dlp (normal, luego cliente Android).
    try {
      const ytdlp = await ensureYtDlp()
      const audio = await downloadWithYtDlp(ytdlp, url, tmpDir)
      return { buffer: audio.buffer, ext: audio.ext, name: `${sanitizeFileName(title)}.${audio.ext || 'm4a'}` }
    } catch (error) {
      errors.push(`yt-dlp: ${error.message}`)
    }
    try {
      const ytdlp = await ensureYtDlp()
      const audio = await downloadWithYtDlp(ytdlp, url, tmpDir, ['--extractor-args', 'youtube:player_client=android,web'])
      return { buffer: audio.buffer, ext: audio.ext, name: `${sanitizeFileName(title)}.${audio.ext || 'm4a'}` }
    } catch (error) {
      errors.push(`yt-dlp android: ${error.message}`)
    }
    // Intento 3: play-dl (scraping de YouTube).
    try {
      const s = await play.stream(url, { quality: 2 })
      const buffer = await streamToBuffer(s.stream, MAX_AUDIO_SIZE)
      const ext = s.type === 'opus' ? 'opus' : (s.type === 'mp4' ? 'm4a' : 'webm')
      return { buffer, ext, name: `${sanitizeFileName(title)}.${ext}` }
    } catch (error) {
      errors.push(`play-dl: ${error.message}`)
    }
    throw new Error(`No pude descargar el audio (${errors.join(' | ')}).`)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function mimeFor(ext) {
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'opus') return 'audio/ogg; codecs=opus'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'webm') return 'audio/webm'
  return 'audio/mpeg'
}

export default {
  command: ['play', 'mp3', 'ytmp3', 'ytaudio', 'playaudio'],
  category: 'downloads',
  description: 'Descarga el audio de un video de YouTube. Uso: `play <nombre o enlace>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args?.[0]) {
      return msg.reply(`Escribe el nombre de la canción o pega el enlace del video.\nEjemplo: *${usedPrefix}play despacito*`)
    }
    const input = args.join(' ').trim()
    try {
      const videoId = getVideoId(input)
      const query = videoId ? `https://youtu.be/${videoId}` : input
      let url = query
      let title = 'audio'
      let thumbnail = null
      try {
        const info = await getVideoInfo(query, videoId)
        if (info) {
          url = info.url || `https://youtu.be/${info.videoId}`
          title = info.title || title
          thumbnail = info.image || info.thumbnail || null
          const infoMessage = `*Descargando audio:* ${title}\n\n*Canal:* ${info.author?.name || info.author || 'Desconocido'}\n*Duración:* ${info.timestamp || 'Desconocida'}\n*Vistas:* ${Number(info.views || 0).toLocaleString('es-PE')}\n*Publicado:* ${info.ago || 'Desconocido'}\n*Enlace:* ${url}`
          if (thumbnail) {
            await sock.sendMessage(msg.chat, { image: { url: thumbnail }, caption: infoMessage }, { quoted: msg })
          } else {
            await msg.reply(infoMessage)
          }
        }
      } catch (error) {
        console.error('[play] no pude obtener la info del video:', error?.message || error)
      }
      if (!isYTUrl(url)) {
        return msg.reply('No encontré un video válido de YouTube para eso.')
      }
      const audio = await getAudio(url, title)
      await sock.sendMessage(msg.chat, {
        audio: audio.buffer,
        fileName: audio.name,
        mimetype: mimeFor(audio.ext),
      }, { quoted: msg })
    } catch (error) {
      console.error('[play] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar el audio. Inténtalo más tarde.')
    }
  },
}
