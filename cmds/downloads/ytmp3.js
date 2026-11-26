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
    // Si la búsqueda no trae el título, se lee con yt-dlp.
    const dl = await fetchYtDlpInfo(`https://youtu.be/${videoId}`)
    if (dl) return dl
    // Con enlace directo no hace falta la búsqueda: se descarga con la URL.
    return { videoId, url: `https://youtu.be/${videoId}` }
  }
  // Búsqueda por nombre: primero yt-search (rápido) y si no encuentra
  // nada (YouTube bloquea el scraping desde el servidor), yt-dlp.
  try {
    const search = await withTimeout(yts(input), 12000, 'YouTube no responde a la búsqueda desde el servidor.')
    const video = search.videos?.[0] || search.all?.find(v => v.type === 'video')
    if (video?.url || video?.videoId) return video
  } catch {}
  await logPlay('yt-search sin resultados, probando yt-dlp')
  return await fetchYtDlpInfo(`ytsearch1:${input}`)
}

// Info del video con yt-dlp (innertube + cookies). Mucho más fiable
// que el scraping de yt-search cuando YouTube bloquea la IP del
// servidor. `target` es una URL o `ytsearch1:<búsqueda>`.
async function fetchYtDlpInfo(target) {
  try {
    const ytdlp = await ensureYtDlp()
    const cookies = await cookieArgs()
    const { stdout } = await execFileAsync(ytdlp, [
      '--dump-json', '--skip-download', '--no-playlist', '--no-warnings',
      '--js-runtimes', 'node',
      ...cookies,
      target,
    ], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 })
    const data = JSON.parse(String(stdout).trim().split('\n')[0])
    if (!data?.id) return null
    const durationSec = Number(data.duration)
    const views = Number(data.view_count)
    const ts = Number(data.timestamp)
    return {
      videoId: data.id,
      url: `https://youtu.be/${data.id}`,
      title: data.title || null,
      author: data.uploader || data.channel || null,
      timestamp: Number.isFinite(durationSec) ? formatDuration(durationSec) : null,
      views: Number.isFinite(views) ? views : null,
      ago: Number.isFinite(ts) && ts > 0 ? relativeTimeEs(ts) : null,
      thumbnail: data.thumbnail || null,
      image: data.thumbnail || null,
      stats: {
        views: Number.isFinite(views) && views > 0 ? views : null,
        timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
      },
    }
  } catch { return null }
}

// yt-dlp verificado una vez por proceso: no hace falta volver a
// ejecutar `--version` (tarda ~1s) en cada intento de descarga.
let ytdlpVerifiedPath = null

// Descarga el binario de yt-dlp si no está (o no ejecuta).
async function ensureYtDlp() {
  if (ytdlpVerifiedPath) return ytdlpVerifiedPath
  try {
    await fs.access(YTDLP_PATH, fs.constants.X_OK)
    await execFileAsync(YTDLP_PATH, ['--version'], { timeout: 15000 })
    ytdlpVerifiedPath = YTDLP_PATH
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
      ytdlpVerifiedPath = YTDLP_PATH
      return YTDLP_PATH
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`No pude preparar yt-dlp: ${lastError?.message || 'descarga fallida'}.`)
}

// Vistas y fecha de subida exactas con yt-dlp. yt-search a veces no
// trae las vistas ni la fecha, así que se leen de aquí. Corre en
// paralelo con la descarga para no hacerla más lenta; si falla, se
// usan los datos de la búsqueda.
async function getVideoStats(url) {
  try {
    const ytdlp = await ensureYtDlp()
    const cookies = await cookieArgs()
    const { stdout } = await execFileAsync(ytdlp, [
      '--print', '%(view_count)s|%(timestamp)s',
      '--skip-download', '--no-playlist', '--no-warnings',
      '--js-runtimes', 'node',
      ...cookies,
      url,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 })
    const [views, timestamp] = String(stdout).trim().split('\n')[0].split('|')
    const v = Number(views)
    const t = Number(timestamp)
    return {
      views: Number.isFinite(v) && v > 0 ? v : null,
      timestamp: Number.isFinite(t) && t > 0 ? t : null,
    }
  } catch { return { views: null, timestamp: null } }
}

async function downloadWithYtDlp(ytdlp, url, tmpDir, extraArgs = [], meta = {}) {
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s')
  const cookies = await cookieArgs()
  await execFileAsync(ytdlp, [
    // m4a de hasta 128 kbps (el audio estándar de YouTube): pesa la mitad
    // que el de 256 kbps y suena igual en el teléfono, así baja más rápido.
    '-f', 'bestaudio[ext=m4a][abr<=128]/bestaudio[ext=m4a]/bestaudio',
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
  if (ext === 'm4a' && meta.thumbPromise && meta.title) {
    const thumbBuffer = await meta.thumbPromise
    const tagged = thumbBuffer ? await embedMetadata(filePath, meta.title, meta.channel || 'YouTube', thumbBuffer, tmpDir) : null
    if (tagged) {
      await logPlay('metadatos incrustados (título + portada)')
      filePath = tagged
    } else {
      await logPlay('metadatos no incrustados (sin ffmpeg o sin miniatura)')
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

// Vistas en corto: 2100000 → "2.1M", 1500 → "1.5K".
function formatViewsCompact(views) {
  const n = Number(views || 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

// Fecha relativa en español, solo la unidad mayor:
// "Hace 23 horas", "Hace 2 días", "Hace 7 meses", "Hace 1 año".
function relativeTimeEs(epochSeconds) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(epochSeconds))
  const minute = 60, hour = 3600, day = 86400, month = 30 * day, year = 365 * day
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  if (diff < minute) return 'Hace unos segundos'
  if (diff < hour) return `Hace ${plural(Math.floor(diff / minute), 'minuto', 'minutos')}`
  if (diff < day) return `Hace ${plural(Math.floor(diff / hour), 'hora', 'horas')}`
  if (diff < month) return `Hace ${plural(Math.floor(diff / day), 'día', 'días')}`
  if (diff < year) return `Hace ${plural(Math.floor(diff / month), 'mes', 'meses')}`
  return `Hace ${plural(Math.floor(diff / year), 'año', 'años')}`
}

// "7 months ago" (lo que da yt-search) → "Hace 7 meses".
// También acepta "Streamed 7 months ago" o "Premiered 2 weeks ago".
function agoToEs(ago) {
  const m = String(ago || '').match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?/i)
  if (!m) return ago || null
  const n = Number(m[1])
  const unit = { second: ['segundo', 'segundos'], minute: ['minuto', 'minutos'], hour: ['hora', 'horas'], day: ['día', 'días'], week: ['semana', 'semanas'], month: ['mes', 'meses'], year: ['año', 'años'] }[m[2].toLowerCase()]
  return `Hace ${n} ${n === 1 ? unit[0] : unit[1]}`
}

// Segundos → "1:31", "1:02:03".
function formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

// "1:31" → 91, "1:02:03" → 3723. Sirve para estimar el tamaño del audio.
function parseDurationSeconds(timestamp) {
  const parts = String(timestamp || '').split(':').map(Number)
  if (!parts.length || parts.some(Number.isNaN)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

function sanitizeFileName(name = 'audio') {
  return String(name)
    .replace(/\.(mp3|m4a|webm|opus|ogg)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio'
}

async function getAudio(url, title, channel, thumbPromise) {
  const errors = []
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-play-'))
  const meta = { title, channel, thumbPromise }
  await logPlay('getAudio inicio:', url)
  try {
    // Intentos yt-dlp (normal, Android, iOS, TV embebido). YouTube bloquea
    // la IP del servidor ("Sign in to confirm you're not a bot") y cada
    // cliente usa un endpoint distinto; iOS y TV a veces pasan donde web no.
    // OJO: iOS y Android fallan en este host (2026-11-26), así que web va
    // primero; si web falla, se prueban los demás.
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
      return msg.reply(`*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✐ ᴜsᴏ » *${usedPrefix}play <nombre o enlace>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}play despacito_`)
    }
    const input = args.join(' ').trim()
    await logPlay('play inicio:', input)
    await msg.react?.('⏳').catch(() => {})
    try {
      const videoId = getVideoId(input)
      const query = videoId ? `https://youtu.be/${videoId}` : input
      let url = query
      let title = 'audio'
      let thumbnail = null
      let channel = 'YouTube'
      // La miniatura se baja en segundo plano y la tarjeta se manda en
      // paralelo con la descarga: antes la tarjeta frenaba el inicio de
      // la descarga ~2s y el audio llegaba más tarde.
      let thumbPromise = Promise.resolve(null)
      let cardPromise = Promise.resolve()
      try {
        const info = await getVideoInfo(query, videoId)
        await logPlay('info:', info?.title ? `título="${String(info.title).slice(0, 80)}"` : (info?.url ? 'solo URL, sin título' : 'sin resultado'), 'vistas=', info?.views, 'ago=', info?.ago)
        if (info?.title) {
          url = info.url || `https://youtu.be/${info.videoId}`
          title = info.title || title
          thumbnail = info.image || info.thumbnail || null
          channel = info.author?.name || info.author || 'YouTube'
          thumbPromise = thumbnail ? getThumbnail(thumbnail) : Promise.resolve(null)
          // Tamaño estimado del audio (128 kbps × duración): el tamaño
          // exacto solo se conoce al bajarlo, pero el estimado queda a
          // un par de % del real porque el bitrate está limitado a 128.
          const durationSec = parseDurationSeconds(info.timestamp)
          const sizeMB = durationSec ? (128 * durationSec / 8 / 1024).toFixed(2) : null
          // Vistas y fecha exactas con yt-dlp (en paralelo con la
          // descarga): yt-search a veces no las trae y salían fijas.
          // Si la búsqueda ya vino de yt-dlp, se reusan sus datos.
          const statsPromise = info.stats
            ? Promise.resolve(info.stats)
            : getVideoStats(url).catch(() => ({ views: null, timestamp: null }))
          cardPromise = (async () => {
            try {
              const [thumb, stats] = await Promise.all([
                thumbPromise,
                withTimeout(statsPromise, 10000, 'stats').catch(() => ({ views: null, timestamp: null })),
              ])
              await logPlay('stats:', stats.views, stats.timestamp)
              const views = stats.views ?? info.views
              const lanzamiento = stats.timestamp ? relativeTimeEs(stats.timestamp) : agoToEs(info.ago)
              const infoMessage = `*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ❀ ᴛíᴛᴜʟᴏ » *${title}*\n> ✐ ᴄᴀɴᴀʟ » *${info.author?.name || info.author || 'Desconocido'}*\n> ⴵ ᴅᴜʀᴀᴄɪóɴ » *${info.timestamp || 'Desconocida'}* │ ✧ *${views != null ? formatViewsCompact(views) : 'Desconocido'}* vistas\n> ✰ ᴄᴀʟɪᴅᴀᴅ » *128 kbps* │ ❒ *${sizeMB ? `${sizeMB} MB` : 'Desconocido'}*\n> ⊞ ʟᴀɴᴢᴀᴍɪᴇɴᴛᴏ » *${lanzamiento || 'Desconocido'}*\n> 🜸 ʟɪɴᴋ » _${url}_`
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
          })()
        } else if (info?.url) {
          url = info.url
        }
      } catch (error) {
        await logPlay('info falló:', String(error?.message || error).slice(0, 200))
        console.error('[play] no pude obtener la info del video:', error?.message || error)
        if (!videoId) {
          await msg.react?.('❌').catch(() => {})
          return msg.reply('*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *No pude buscar en YouTube: no responde desde el servidor. Prueba pegando el enlace directo del video.*')
        }
        url = `https://youtu.be/${videoId}`
      }
      if (!isYTUrl(url)) {
        await msg.react?.('❌').catch(() => {})
        return msg.reply('*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *No encontré un video válido de YouTube para eso.*')
      }
      // Límite total de 5 min para toda la descarga: el comando siempre
      // responde algo, aunque un intento se quede esperando.
      const audio = await withTimeout(getAudio(url, title, channel, thumbPromise), 300000, 'La descarga del audio tardó demasiado (5 min). Prueba con otro video o más tarde.')
      // La tarjeta (si la hay) ya debió llegar; se le esperan como mucho
      // 2s para que el audio no le gane y aparezca antes que el aviso.
      await Promise.race([cardPromise, new Promise(resolve => setTimeout(resolve, 2000))])
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
      await msg.react?.('✅').catch(() => {})
    } catch (error) {
      await logPlay('play error:', String(error?.message || error).slice(0, 300))
      console.error('[play] error:', error?.stack || error)
      await msg.react?.('❌').catch(() => {})
      await msg.reply(`*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *${error?.message || 'No pude descargar el audio. Inténtalo más tarde.'}*`)
    }
  },
}
