// ytmp3.js — Descargar el audio de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs de terceros: busca con yt-search (scraping)
// y descarga con yt-dlp (scrapea YouTube directo, sin API key).
// yt-dlp es un binario que se descarga solo a lib/yt-dlp la primera
// vez (desde GitHub, versión fijada + fallback a latest) y se reutiliza.
// OJO: tiene que ser el asset yt-dlp_linux (ELF standalone). El asset
// yt-dlp a secas es un script de Python (zipapp): falla la validación
// ELF y el contenedor no tiene Python para ejecutarlo.
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

// Límite de tiempo para no quedarse colgado: YouTube a veces deja la
// conexión sin responder desde la IP del servidor y sin esto el comando
// se queda congelado sin mandar ni error. La promesa original sigue en
// segundo plano, pero el comando ya no se queda esperando para siempre.
function withTimeout(promise, ms, errorMessage) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(errorMessage || `La operación tardó demasiado (${Math.round(ms / 1000)}s).`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// Registro de depuración de `play` en el host (lib/system/play-debug.log):
// cada paso del comando deja una línea con hora, para ver exactamente
// dónde se queda cuando no manda nada. Nunca rompe el comando.
const PLAY_DEBUG_LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'system', 'play-debug.log')
async function logPlay(...parts) {
  try {
    const stat = await fs.stat(PLAY_DEBUG_LOG).catch(() => null)
    if (stat && stat.size > 200 * 1024) await fs.rm(PLAY_DEBUG_LOG, { force: true }).catch(() => {})
    await fs.appendFile(PLAY_DEBUG_LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch {}
}

async function getVideoInfo(input, videoId) {
  if (videoId) {
    try {
      const info = await withTimeout(yts({ videoId }), 25000, 'YouTube no responde a la búsqueda desde el servidor.')
      if (info?.videoId) {
        return { ...info, url: `https://youtu.be/${info.videoId}`, image: info.thumbnail || info.image }
      }
    } catch {}
    // Con enlace directo no hace falta la búsqueda: se descarga con la URL.
    return { videoId, url: `https://youtu.be/${videoId}` }
  }
  const search = await withTimeout(yts(input), 25000, 'YouTube no responde a la búsqueda desde el servidor.')
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

async function downloadWithYtDlp(ytdlp, url, tmpDir, extraArgs = [], meta = {}) {
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s')
  const cookies = await cookieArgs()
  await execFileAsync(ytdlp, [
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--js-runtimes', 'node',
    '--no-playlist', '--no-warnings',
    ...cookies,
    ...extraArgs,
    '-o', outTemplate,
    url,
  ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 })
  const files = await fs.readdir(tmpDir)
  const file = files.find(f => /^audio\.[a-z0-9]+$/i.test(f))
  if (!file) throw new Error('yt-dlp terminó sin dejar el audio.')
  let filePath = path.join(tmpDir, file)
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_AUDIO_SIZE) throw new Error(`El audio pesa ${(stat.size / 1024 / 1024).toFixed(1)} MB, más del límite de 64 MB.`)
  if (stat.size === 0) throw new Error('yt-dlp dejó el audio vacío.')
  const ext = path.extname(file).slice(1).toLowerCase()
  // El archivo lleva su nombre y su portada incrustados (solo m4a y con
  // miniatura). Si no se puede, se manda el audio tal cual.
  if (ext === 'm4a' && meta.thumbBuffer && meta.title) {
    const tagged = await embedMetadata(filePath, meta.title, meta.channel || 'YouTube', meta.thumbBuffer, tmpDir)
    if (tagged) {
      await logPlay('metadatos incrustados (título + portada)')
      filePath = tagged
    } else {
      await logPlay('metadatos no incrustados (sin ffmpeg o falló)')
    }
  }
  const buffer = await fs.readFile(filePath)
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

// Baja la miniatura como Buffer para la tarjeta del audio. Si falla,
// devuelve null y el audio se manda igual, solo con el título.
async function getThumbnail(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length ? buffer : null
  } catch { return null }
}

// Incrusta título, artista y portada en el audio con ffmpeg (si está
// en el servidor): así el archivo guardado muestra su nombre y su
// portada en el reproductor/archivos del teléfono. Si falla o no hay
// ffmpeg, se manda el audio tal cual, sin romper la descarga.
async function embedMetadata(filePath, title, channel, thumbBuffer, tmpDir) {
  try {
    const coverPath = path.join(tmpDir, 'cover.jpg')
    await fs.writeFile(coverPath, thumbBuffer)
    const outPath = path.join(tmpDir, 'audio-tagged.m4a')
    await execFileAsync('ffmpeg', [
      '-y', '-i', filePath, '-i', coverPath,
      '-map', '0:a', '-map', '1:v',
      '-c', 'copy',
      '-metadata', `title=${title}`,
      '-metadata', `artist=${channel}`,
      '-metadata:s:v', 'title=Album cover',
      '-metadata:s:v', 'comment=Cover (front)',
      '-disposition:v', 'attached_pic',
      outPath,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
    const stat = await fs.stat(outPath)
    if (stat.size > 0) return outPath
  } catch {}
  return null
}

function sanitizeFileName(name = 'audio') {
  return String(name)
    .replace(/\.(mp3|m4a|webm|opus|ogg)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio'
}

async function getAudio(url, title, channel, thumbBuffer) {
  const errors = []
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-play-'))
  const meta = { title, channel, thumbBuffer }
  await logPlay('getAudio inicio:', url)
  try {
    // Intentos yt-dlp (normal, Android, iOS, TV embebido). YouTube bloquea
    // la IP del servidor ("Sign in to confirm you're not a bot") y cada
    // cliente usa un endpoint distinto; iOS y TV a veces pasan donde web no.
    try {
      const ytdlp = await ensureYtDlp()
      const audio = await downloadWithYtDlp(ytdlp, url, tmpDir, [], meta)
      await logPlay('yt-dlp web OK:', audio.ext)
      return { buffer: audio.buffer, ext: audio.ext, name: `${sanitizeFileName(title)}.${audio.ext || 'm4a'}` }
    } catch (error) {
      errors.push(`yt-dlp: ${error.message}`)
      await logPlay('yt-dlp web falló:', String(error.message).slice(0, 200))
    }
    try {
      const ytdlp = await ensureYtDlp()
      const audio = await downloadWithYtDlp(ytdlp, url, tmpDir, ['--extractor-args', 'youtube:player_client=android,web'], meta)
      await logPlay('yt-dlp android OK:', audio.ext)
      return { buffer: audio.buffer, ext: audio.ext, name: `${sanitizeFileName(title)}.${audio.ext || 'm4a'}` }
    } catch (error) {
      errors.push(`yt-dlp android: ${error.message}`)
      await logPlay('yt-dlp android falló:', String(error.message).slice(0, 200))
    }
    try {
      const ytdlp = await ensureYtDlp()
      const audio = await downloadWithYtDlp(ytdlp, url, tmpDir, ['--extractor-args', 'youtube:player_client=ios'], meta)
      await logPlay('yt-dlp ios OK:', audio.ext)
      return { buffer: audio.buffer, ext: audio.ext, name: `${sanitizeFileName(title)}.${audio.ext || 'm4a'}` }
    } catch (error) {
      errors.push(`yt-dlp ios: ${error.message}`)
      await logPlay('yt-dlp ios falló:', String(error.message).slice(0, 200))
    }
    try {
      const ytdlp = await ensureYtDlp()
      const audio = await downloadWithYtDlp(ytdlp, url, tmpDir, ['--extractor-args', 'youtube:player_client=tv_embedded'], meta)
      await logPlay('yt-dlp tv OK:', audio.ext)
      return { buffer: audio.buffer, ext: audio.ext, name: `${sanitizeFileName(title)}.${audio.ext || 'm4a'}` }
    } catch (error) {
      errors.push(`yt-dlp tv: ${error.message}`)
      await logPlay('yt-dlp tv falló:', String(error.message).slice(0, 200))
    }
    // Intento 5: play-dl (scraping de YouTube). Con límite de 60s: su
    // stream puede quedarse esperando para siempre si YouTube no responde.
    try {
      await logPlay('play-dl inicio')
      const s = await withTimeout(play.stream(url, { quality: 2 }), 60000, 'play-dl no respondió en 60s.')
      const buffer = await withTimeout(streamToBuffer(s.stream, MAX_AUDIO_SIZE), 60000, 'play-dl dejó de mandar datos.')
      const ext = s.type === 'opus' ? 'opus' : (s.type === 'mp4' ? 'm4a' : 'webm')
      await logPlay('play-dl OK:', ext)
      return { buffer, ext, name: `${sanitizeFileName(title)}.${ext}` }
    } catch (error) {
      errors.push(`play-dl: ${error.message}`)
      await logPlay('play-dl falló:', String(error.message).slice(0, 200))
    }
    await logPlay('getAudio sin éxito:', errors.join(' | ').slice(0, 300))
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
    await logPlay('play inicio:', input)
    try {
      const videoId = getVideoId(input)
      const query = videoId ? `https://youtu.be/${videoId}` : input
      let url = query
      let title = 'audio'
      let thumbnail = null
      let channel = 'YouTube'
      let thumb = null
      try {
        const info = await getVideoInfo(query, videoId)
        await logPlay('info:', info?.title ? `título="${String(info.title).slice(0, 80)}"` : (info?.url ? 'solo URL, sin título' : 'sin resultado'))
        if (info?.title) {
          url = info.url || `https://youtu.be/${info.videoId}`
          title = info.title || title
          thumbnail = info.image || info.thumbnail || null
          channel = info.author?.name || info.author || 'YouTube'
          thumb = thumbnail ? await getThumbnail(thumbnail) : null
          const infoMessage = `*Descargando audio:* ${title}\n\n*Canal:* ${info.author?.name || info.author || 'Desconocido'}\n*Duración:* ${info.timestamp || 'Desconocida'}\n*Vistas:* ${Number(info.views || 0).toLocaleString('es-PE')}\n*Publicado:* ${info.ago || 'Desconocido'}\n*Enlace:* ${url}`
          try {
            if (thumb) {
              await withTimeout(sock.sendMessage(msg.chat, { image: thumb, caption: infoMessage }, { quoted: msg }), 20000, 'La tarjeta de info no se pudo enviar.')
              await logPlay('tarjeta enviada (buffer)')
            } else if (thumbnail) {
              await withTimeout(sock.sendMessage(msg.chat, { image: { url: thumbnail }, caption: infoMessage }, { quoted: msg }), 20000, 'La tarjeta de info no se pudo enviar.')
              await logPlay('tarjeta enviada (URL)')
            } else {
              await withTimeout(msg.reply(infoMessage), 20000, 'El mensaje de info no se pudo enviar.')
              await logPlay('info enviada (texto)')
            }
          } catch (error) {
            await logPlay('tarjeta falló:', String(error?.message || error).slice(0, 200))
            console.error('[play] no pude mandar la tarjeta:', error?.message || error)
          }
        } else if (info?.url) {
          url = info.url
        }
      } catch (error) {
        await logPlay('info falló:', String(error?.message || error).slice(0, 200))
        console.error('[play] no pude obtener la info del video:', error?.message || error)
        if (!videoId) {
          return msg.reply('No pude buscar en YouTube: no responde desde el servidor. Prueba pegando el enlace directo del video.')
        }
        url = `https://youtu.be/${videoId}`
      }
      if (!isYTUrl(url)) {
        return msg.reply('No encontré un video válido de YouTube para eso.')
      }
      // Límite total de 5 min para toda la descarga: el comando siempre
      // responde algo, aunque un intento se quede esperando.
      const audio = await withTimeout(getAudio(url, title, channel, thumb), 300000, 'La descarga del audio tardó demasiado (5 min). Prueba con otro video o más tarde.')
      await logPlay('audio listo, enviando:', audio.name)
      // El audio se manda pelado (sin tarjeta de enlace encima): la
      // tarjeta rompía cómo se ve el mensaje en WhatsApp. El nombre y
      // la portada van DENTRO del archivo (título y portada incrustados).
      await sock.sendMessage(msg.chat, {
        audio: audio.buffer,
        fileName: audio.name,
        mimetype: mimeFor(audio.ext),
      }, { quoted: msg })
      await logPlay('audio enviado OK')
    } catch (error) {
      await logPlay('play error:', String(error?.message || error).slice(0, 300))
      console.error('[play] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar el audio. Inténtalo más tarde.')
    }
  },
}
