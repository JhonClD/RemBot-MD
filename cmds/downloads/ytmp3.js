// ytmp3.js — Descargar el audio de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs de terceros: busca con yt-search (scraping)
// y descarga con yt-dlp (scrapea YouTube directo, sin API key).
// yt-dlp se descarga automáticamente a lib/yt-dlp la primera vez (ELF
// standalone para x64 o arm64) de forma atómica y se reutiliza.
// Fallbacks de descarga: 1) yt-dlp web/default, 2) android_vr, 3) mweb,
// 4) tv_embedded, 5) play-dl. Normaliza siempre a M4A (AAC + faststart)
// con título, artista y portada JPEG real incrustados, y genera miniatura
// HD 16:9 + jpegThumbnail optimizado para WhatsApp.

import yts from 'yt-search'
import play from 'play-dl'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BOT_ROOT = path.resolve(__dirname, '..', '..')
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'

const YTDLP_VERSION = '2026.11.23'
const YTDLP_ASSET = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
const YTDLP_URLS = [
  `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_ASSET}`,
  `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`,
]
const YTDLP_PATH = path.join(BOT_ROOT, 'lib', 'yt-dlp')
const COOKIE_CANDIDATES = [
  path.join(BOT_ROOT, 'lib', 'cookies.txt'),
  path.join(BOT_ROOT, 'cookies.txt'),
  path.resolve(BOT_ROOT, '..', 'cookies.txt'),
]

const MAX_AUDIO_SIZE = 64 * 1024 * 1024 // 64 MB
const WA_MICRO_THUMB_MAX_EDGE = 96
const WA_MICRO_THUMB_MAX_BYTES = 8 * 1024

const ytdlpState = globalThis.__rembotYtDlpState ??= { verifiedPath: null, initPromise: null }

// Si existe cookies.txt con contenido, yt-dlp lo usa para saltar bloqueos por IP.
async function cookieArgs() {
  for (const candidate of COOKIE_CANDIDATES) {
    try {
      const st = await fs.stat(candidate)
      if (st.isFile() && st.size > 0) return ['--cookies', candidate]
    } catch {}
  }
  return []
}

function ffmpegLocationArgs() {
  return process.env.FFMPEG_PATH ? ['--ffmpeg-location', process.env.FFMPEG_PATH] : []
}

const YT_URL_RE = /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"']+/i

const isYTUrl = (url = '') =>
  /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/.+$/i.test(String(url || '').trim())

// Extrae el ID de 11 caracteres solo desde enlaces reales de YouTube
// (incluyendo m.youtube.com, music.youtube.com, shorts, live y texto compartido),
// sin confundir búsquedas de 11 letras (ej. "DragonBallZ", "ChainsawMan") con IDs.
function getVideoId(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return null
  const urlMatch = raw.match(YT_URL_RE)?.[0] || (isYTUrl(raw) ? raw : null)
  if (!urlMatch) return null
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})(?:[/?#&]|$)/i,
    /youtube(?:-nocookie)?\.com\/(?:watch\/?\?(?:[^#\s]*&)?v=|embed\/|shorts\/|live\/|v\/|attribution_link\?.*v(?:%3D|=))([a-zA-Z0-9_-]{11})/i,
    /[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/i,
  ]
  for (const pattern of patterns) {
    const match = urlMatch.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

function extractYTUrlFromText(text = '') {
  const m = String(text || '').match(YT_URL_RE)
  return m ? m[0].replace(/[.,;:!?)]+$/g, '') : null
}

function withTimeout(promise, ms, errorMessage, onTimeout) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.() } catch {}
        reject(new Error(errorMessage || `La operación tardó demasiado (${Math.round(ms / 1000)}s).`))
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const PLAY_DEBUG_LOG = path.join(BOT_ROOT, 'lib', 'system', 'play-debug.log')
async function logPlay(...parts) {
  try {
    const stat = await fs.stat(PLAY_DEBUG_LOG).catch(() => null)
    if (stat && stat.size > 200 * 1024) await fs.rm(PLAY_DEBUG_LOG, { force: true }).catch(() => {})
    await fs.mkdir(path.dirname(PLAY_DEBUG_LOG), { recursive: true })
    await fs.appendFile(PLAY_DEBUG_LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch {}
}

// Carga sharp (incluido como dependencia de baileys) o devuelve null para usar ffmpeg.
let sharpLoaderPromise = null
async function loadSharp() {
  if (!sharpLoaderPromise) {
    sharpLoaderPromise = (async () => {
      try {
        const mod = await import('sharp')
        return mod.default || mod
      } catch {}
      try {
        const req = createRequire(import.meta.url)
        const baileysReq = createRequire(req.resolve('baileys'))
        const mod = baileysReq('sharp')
        return mod.default || mod
      } catch {}
      return null
    })()
  }
  return sharpLoaderPromise
}

// Candidatos de miniatura de YouTube en orden de calidad (JPEG nativo primero
// para evitar WebP roto y barras negras 4:3 cuando existe versión 16:9 HD).
function buildThumbCandidates(videoId, rawThumb) {
  const list = []
  if (videoId) {
    list.push(
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
      `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    )
  }
  if (rawThumb && !list.includes(rawThumb)) list.push(rawThumb)
  if (videoId) list.push(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`)
  return list
}

async function fetchRawThumbnail(candidates) {
  for (const url of candidates) {
    if (!url) continue
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const buffer = Buffer.from(await res.arrayBuffer())
      // YouTube devuelve un placeholder gris de ~1 KB cuando no existe esa variante.
      if (buffer.length > 2500) return buffer
    } catch {}
  }
  return null
}

function fitMaxEdge(width, height, maxEdge = WA_MICRO_THUMB_MAX_EDGE) {
  const w = Math.max(1, Number(width) || 16)
  const h = Math.max(1, Number(height) || 9)
  const scale = maxEdge / Math.max(w, h)
  return {
    width: Math.max(16, Math.round(w * scale)),
    height: Math.max(16, Math.round(h * scale)),
  }
}

// Procesa la miniatura para WhatsApp:
// 1) Convierte cualquier formato (WebP/PNG/JPEG) a JPEG baseline real (sin progressive).
// 2) Recorta barras negras 4:3 (480x360 / 640x480 de YouTube) a 16:9 limpio.
// 3) Genera jpegThumbnail nítido (<=96px, <8 KB) para que WhatsApp móvil y web
//    muestren la vista previa al instante, más portada JPEG válida para incrustar en M4A.
async function processThumbBuffer(rawBuffer) {
  if (!rawBuffer?.length) return null
  const sharp = await loadSharp()
  if (sharp) {
    try {
      const meta = await sharp(rawBuffer).metadata()
      let w = meta.width || 1280
      let h = meta.height || 720
      let pipeline = sharp(rawBuffer).rotate()
      if (w > 0 && h > 0 && Math.abs(w / h - 4 / 3) < 0.06) {
        const cropH = Math.max(2, Math.floor((w * 9 / 16) / 2) * 2)
        const top = Math.max(0, Math.floor((h - cropH) / 2))
        pipeline = pipeline.extract({ left: 0, top, width: w, height: cropH })
        h = cropH
      }
      const card = await pipeline
        .resize({ width: 1280, height: 720, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
        .jpeg({ quality: 88, progressive: false, mozjpeg: false, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true })

      const microDims = fitMaxEdge(card.info.width, card.info.height, WA_MICRO_THUMB_MAX_EDGE)
      let microBuffer = await sharp(card.data)
        .resize({ width: microDims.width, height: microDims.height, fit: 'cover', position: 'centre', kernel: 'lanczos3' })
        .sharpen(0.5)
        .jpeg({ quality: 76, progressive: false, mozjpeg: false, chromaSubsampling: '4:2:0' })
        .toBuffer()
      if (microBuffer.length > WA_MICRO_THUMB_MAX_BYTES) {
        microBuffer = await sharp(card.data)
          .resize({ width: microDims.width, height: microDims.height, fit: 'cover', position: 'centre', kernel: 'lanczos3' })
          .jpeg({ quality: 58, progressive: false, mozjpeg: false, chromaSubsampling: '4:2:0' })
          .toBuffer()
      }
      return {
        cardBuffer: card.data,
        width: card.info.width,
        height: card.info.height,
        microBuffer,
        coverBuffer: card.data,
      }
    } catch {}
  }

  // Respaldo con FFmpeg si sharp no está disponible (ej. Termux ARM).
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-ytthumb-'))
  try {
    const inPath = path.join(tmpDir, 'in.img')
    const cardPath = path.join(tmpDir, 'card.jpg')
    const microPath = path.join(tmpDir, 'micro.jpg')
    await fs.writeFile(inPath, rawBuffer)
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
      '-vf', "crop=iw:'if(lt(abs(iw/ih-4/3),0.06),trunc(iw*9/32)*2,ih)',scale='min(1280,iw)':-2:flags=lanczos,format=yuvj420p",
      '-frames:v', '1', '-update', '1', '-q:v', '3', cardPath,
    ], { timeout: 15000 })
    const dims = await probeDimensions(cardPath)
    const microDims = fitMaxEdge(dims.width || 1280, dims.height || 720, WA_MICRO_THUMB_MAX_EDGE)
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', cardPath,
      '-vf', `scale=${microDims.width}:${microDims.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${microDims.width}:${microDims.height},unsharp=3:3:0.35:3:3:0.0,format=yuvj420p`,
      '-frames:v', '1', '-update', '1', '-q:v', '5', microPath,
    ], { timeout: 15000 })
    const [cardBuffer, microBuffer] = await Promise.all([
      fs.readFile(cardPath),
      fs.readFile(microPath).catch(() => null),
    ])
    if (!cardBuffer?.length) return null
    return {
      cardBuffer,
      width: dims.width || 1280,
      height: dims.height || 720,
      microBuffer: microBuffer?.length && microBuffer.length <= WA_MICRO_THUMB_MAX_BYTES ? microBuffer : null,
      coverBuffer: cardBuffer,
    }
  } catch {
    return null
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function prepareThumbBundle(videoId, rawThumb) {
  const raw = await fetchRawThumbnail(buildThumbCandidates(videoId, rawThumb))
  if (!raw) return null
  return processThumbBuffer(raw)
}

async function probeDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json', filePath,
    ], { timeout: 8000 })
    const s = JSON.parse(stdout)?.streams?.[0]
    return { width: Number(s?.width) || null, height: Number(s?.height) || null }
  } catch {
    return { width: null, height: null }
  }
}

async function probeAudioInfo(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name:format=duration',
      '-of', 'json', filePath,
    ], { timeout: 10000 })
    const parsed = JSON.parse(stdout)
    const audioStream = (parsed?.streams || []).find(s => s.codec_type === 'audio')
    const hasVideo = (parsed?.streams || []).some(s => s.codec_type === 'video')
    const dur = Number(parsed?.format?.duration)
    return {
      acodec: audioStream?.codec_name || null,
      hasVideo,
      durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
    }
  } catch {
    return { acodec: null, hasVideo: false, durationSec: null }
  }
}

const ROMAN_MAP = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12' }

const BASE_STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'y', 'o', 'u', 'a', 'e',
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'and', 'or', 'from',
  'feat', 'ft', 'prod', 'x', 'vs',
  'oficial', 'official', 'video', 'audio', 'music', 'musica', 'cancion', 'song', 'hd', '4k', 'hq', '1080p', '720p', 'mv',
])

// Limpia muletillas habituales de WhatsApp ("pon", "descargar ... mp3") sin tocar enlaces ni palabras clave reales.
function cleanSearchQuery(raw = '') {
  let q = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!q || getVideoId(q) || isYTUrl(q)) return q
  const strippedLead = q.replace(/^(?:pon(?:me)?|busca(?:r)?|descarga(?:r)?|baja(?:r)?|reproduce|quiero\s+(?:escuchar|ver|descargar))\s+/i, '').trim()
  if (strippedLead.length >= 2) q = strippedLead
  const strippedTrail = q.replace(/\s+\b(?:mp3|mp4|m4a|descargar|download|gratis)\b$/i, '').trim()
  if (strippedTrail.length >= 2) q = strippedTrail
  return q
}

function normalizeMatchText(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[()[\]{}|"'`“”‘’•·—–―/\\:;,!?+*~^]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => ROMAN_MAP[w] || w)
    .join(' ')
}

function parseViewsAny(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v || '').trim()
  if (!s) return null
  const compact = s.replace(/,/g, '').match(/^([\d.]+)\s*([KMB])\b/i)
  if (compact) {
    const n = parseFloat(compact[1])
    if (Number.isNaN(n)) return null
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[compact[2].toUpperCase()] || 1
    return Math.round(n * mult)
  }
  const digits = s.replace(/[^\d]/g, '')
  return digits ? Number(digits) : null
}

function channelMatchesArtistInTitle(titleRaw = '', channelRaw = '') {
  const chClean = normalizeMatchText(String(channelRaw).replace(/\b(?:el|la|los|las|the|official|oficial|vevo|topic|music|records|tv|channel|canal)\b/gi, ''))
  if (!chClean || chClean.length < 2) return false
  const parts = String(titleRaw).split(/\s*[-–—｜|]\s*/)
  if (parts.length < 2) return normalizeMatchText(titleRaw).startsWith(chClean)
  const left = normalizeMatchText(parts[0])
  const right = normalizeMatchText(parts[parts.length - 1])
  return Boolean(
    (left && (left.includes(chClean) || chClean.includes(left))) ||
    (right && right.length >= 3 && (right.includes(chClean) || chClean.includes(right))),
  )
}

function analyzeQueryIntent(query = '') {
  const q = String(query || '')
  const qn = normalizeMatchText(q)
  return {
    live: /\b(live|en\s+vivo|directo|concierto|concert|unplugged|tiny\s+desk|session|sesion|festival|tour|live\s+aid|orchestra|orquesta|sinfonica|symphony)\b/i.test(qn),
    cover: /\b(cover|version\s+acustica|acustico|acoustic|piano|guitar|guitarra|ukulele|violin|tributo|tribute|parodia|parody)\b/i.test(qn),
    remix: /\b(remix|rmx|mashup|bootleg|flip|dj|club\s+mix|extended\s+mix|afro\s+house|guaracha)\b/i.test(qn),
    editMod: /\b(sped\s*up|speed\s*up|slowed|reverb|nightcore|daycore|8d|bass\s*boost(?:ed)?)\b/i.test(qn),
    karaoke: /\b(karaoke|instrumental|pista|backing\s*track|off\s*vocal|sin\s*voz|acapella|a\s*capella)\b/i.test(qn),
    lyrics: /\b(lyrics?|letra|sub\s*espanol|traducid[oa]|traduccion|subtitulad[oa]|romaji)\b/i.test(qn),
    officialVideo: /\b(video\s*oficial|official\s*(?:music\s*)?video|\bmv\b|videoclip|clip\s*oficial)\b/i.test(qn),
    officialAudio: /\b(audio\s*oficial|official\s*audio|topic)\b/i.test(qn),
    op: /\bop\s*\d*\b|opening|オープニング/i.test(q),
    ed: /\bed\s*\d*\b|ending|エンディング/i.test(q),
    full: /\bfull\b|フル|complet[oa]|extended/i.test(q),
    albumOrLong: /\b(album|playlist|mix|compilacion|compilation|megamix|set|1\s*hora|1\s*hour|\d+\s*h(?:oras?|ours?)?|podcast|episodio|episode|capitulo|pelicula|movie|documental|gameplay|walkthrough|conferencia|audiolibro)\b|todos los/i.test(qn),
    shortClip: /\b(shorts?|tiktok|reel|meme|clip|estado|status|edit|amv|mmv)\b/i.test(qn),
    tutorial: /\b(tutorial|curso|clase|como\s+hacer|como\s+tocar|how\s+to|guia|aprende|aprender|acordes|chords)\b/i.test(qn),
    reaction: /\b(reaccion|reaction|reacting\s+to|first\s+time|review|analisis|critica|opinion)\b/i.test(qn),
  }
}

// Puntúa cualquier música o video para encontrar la mejor pista de AUDIO:
// prioriza canales oficiales de artista (🎵), pistas maestras "- Topic" y Audio Oficial/Visualizer,
// coincidencia real de título/artista, popularidad, y filtra covers, remixes, sped-up, karaoke,
// reacciones, tutoriales, directos activos o compilaciones de horas cuando no fueron pedidos.
function scoreAudioCandidate(c, idx, query, allCands) {
  const intent = analyzeQueryIntent(query)
  const tRaw = String(c.title || '')
  const chRaw = String(c.author?.name || c.author || c.channel || '')
  const descRaw = String(c.description || '')
  const tNorm = normalizeMatchText(tRaw)
  const chNorm = normalizeMatchText(chRaw)
  const descNorm = normalizeMatchText(descRaw)
  const combined = `${tNorm} ${chNorm}`
  const fullHay = `${combined} ${descNorm}`
  const dur = c.durationSec

  let score = Math.max(0, 30 - idx * 1.8)

  const dynamicStops = new Set(BASE_STOP_WORDS)
  if (intent.full) ['full', 'completo', 'completa', 'extended'].forEach(w => dynamicStops.add(w))
  if (intent.op || intent.ed) ['op', 'ed', 'opening', 'ending'].forEach(w => dynamicStops.add(w))
  if (intent.lyrics) ['letra', 'lyrics', 'lyric'].forEach(w => dynamicStops.add(w))

  const qNorm = normalizeMatchText(query)
  const rawTokens = qNorm.split(' ').filter(w => w.length >= 1 && !dynamicStops.has(w))
  const tokens = rawTokens.length ? rawTokens : qNorm.split(' ').filter(Boolean)
  const hayWords = new Set(combined.split(' '))
  const fullHayWords = new Set(fullHay.split(' '))
  const titleWords = new Set(tNorm.split(' '))
  const chWords = new Set(chNorm.split(' '))

  const matchesToken = (wordSet, fullStr, tok) => {
    if (wordSet.has(tok)) return true
    if (tok.length >= 4 && fullStr.includes(tok)) return true
    if ((tok === 'espanol' || tok === 'latino') && /\b(espanol|espana|latino|latinoamerica|america\s+latina|subtitulado|doblado)\b/.test(fullStr)) return true
    return false
  }

  if (tokens.length) {
    let hitScore = 0
    for (const tok of tokens) {
      if (matchesToken(hayWords, combined, tok)) hitScore += 1
      else if (matchesToken(fullHayWords, fullHay, tok)) hitScore += 0.65
    }
    score += (hitScore / tokens.length) * 58

    const nonChannelTokens = tokens.filter(tok => !matchesToken(chWords, chNorm, tok))
    if (nonChannelTokens.length && nonChannelTokens.length < tokens.length) {
      const titleMatched = nonChannelTokens.filter(tok => matchesToken(titleWords, tNorm, tok) || matchesToken(fullHayWords, descNorm, tok))
      if (titleMatched.length === 0) {
        const someoneMatchesTitle = allCands.some(other => {
          const ot = normalizeMatchText(other.title || '')
          const ow = new Set(ot.split(' '))
          return nonChannelTokens.some(tok => matchesToken(ow, ot, tok))
        })
        if (someoneMatchesTitle) score -= 120
      } else {
        score += (titleMatched.length / nonChannelTokens.length) * 24
      }
    }
  }

  if (qNorm.length >= 4 && combined.includes(qNorm)) score += 15

  const isTopic = /\b-\s*topic$/i.test(chRaw) || /provided to youtube by/i.test(descRaw)
  const isVevo = /vevo$/i.test(chRaw.replace(/\s+/g, ''))
  const matchesTitleArtist = channelMatchesArtistInTitle(tRaw, chRaw)
  const isKnownPublisher = /\b(official|oficial|records|music|entertainment|animation|aniplex|toho|crunchyroll|rockstar\s*games|playstation|nintendo|xbox|netflix|marvel|warner|sony|universal|hybe|smtown|jyp|yg|bighit)\b/i.test(chRaw)
  const trustedChannel = Boolean(c.isArtist || isVevo || isTopic || c.isVerified || matchesTitleArtist || isKnownPublisher)

  if (c.isArtist || isVevo) score += 55
  else if (matchesTitleArtist) score += 42
  else if (c.isVerified) score += 24
  else if (isKnownPublisher) score += 20

  if (!c.isArtist && !c.isVerified && /\b(jr|fan|fans|fanpage|clips|reupload)\b/i.test(chNorm)) {
    score -= 30
  }

  if (c.views != null && c.views > 0) {
    score += Math.min(42, Math.log10(c.views + 1) * 4.5)
  }

  if (c.isLive && !intent.live) score -= 300

  const isCoverVid = /\b(cover|acoustic|acustic[oa]|guitar\s+rendition|piano\s+version|tributo|tribute|parodia|parody)\b/i.test(tNorm)
  if (intent.cover) { if (isCoverVid) score += 60 } else if (isCoverVid) score -= 55

  const isRemixVid = /\b(remix|rmx|mashup|bootleg|afro\s+house|guaracha|club\s+mix)\b/i.test(tNorm)
  if (intent.remix) { if (isRemixVid) score += 60 } else if (isRemixVid) score -= 50

  const isModVid = /\b(sped\s*up|speed\s*up|slowed|reverb|nightcore|daycore|8d\s+audio|bass\s*boost(?:ed)?)\b/i.test(tNorm)
  if (intent.editMod) { if (isModVid) score += 65 } else if (isModVid) score -= 65

  const isKaraokeVid = /\b(karaoke|instrumental|pista|backing\s*track|off\s*vocal|sin\s*voz|acapella)\b/i.test(tNorm)
  if (intent.karaoke) { if (isKaraokeVid) score += 65 } else if (isKaraokeVid) score -= 75

  const isTutorialVid = /\b(tutorial|curso|clase|como\s+hacer|como\s+tocar|how\s+to\s+play|chords|acordes)\b/i.test(tNorm)
  if (intent.tutorial) { if (isTutorialVid) score += 60 } else if (isTutorialVid) score -= 65

  const isReactionVid = /\b(reaccion|reaction|reacting\s+to|first\s+time\s+(?:hearing|watching)|review|critica)\b/i.test(tNorm)
  if (intent.reaction) { if (isReactionVid) score += 60 } else if (isReactionVid) score -= 70

  const isLivePerf = /\b(en\s+vivo|live\s+at|live\s+from|live\s+performance|concierto|fancam|lollapalooza|coachella|live\s+aid|unplugged|imperial\s+orchestra|live\s+orchestra)\b/i.test(`${tNorm} ${chNorm}`)
  if (intent.live) { if (isLivePerf || c.isLive) score += 60 } else if (isLivePerf) score -= 32

  const isLyricVid = /\b(lyrics?|letra|lyric\s+video|video\s+lyric|anime\s+lyric|sub\s+espanol|traducid[oa])\b/i.test(tNorm)
  if (intent.lyrics && isLyricVid) score += 45

  const isCompilation = /\b(playlist|album|compilacion|compilation|megamix|todos\s+los|all\s+(?:openings|endings|songs)|1\s*hora|1\s*hour|\b1h\b|\bmix\b|full\s+album|full\s+ost)\b/i.test(tNorm)

  if (dur != null && dur > 9000) score -= 180
  else if (dur != null && dur > 5400 && !intent.albumOrLong) score -= 160

  const hasOpTag = /オープニング|opening|\bop\s*\d*\b/i.test(tRaw)
  const hasEdTag = /エンディング|ending|\bed\s*\d*\b/i.test(tRaw)

  if (intent.albumOrLong || intent.tutorial) {
    if (isCompilation && intent.albumOrLong) score += 65
    if (dur != null) {
      if (dur >= 600 && dur <= 7200) score += 60
      else if (dur >= 240 && dur < 600) score += 25
      else if (dur < 90) score -= 40
    }
  } else if ((intent.op || intent.ed) && !intent.full) {
    if (dur != null) {
      if (dur >= 50 && dur <= 145) score += 95
      else if (dur > 145 && dur <= 220) score += 15
      else if (dur > 220) score -= 55
    }
    if (intent.op && !intent.ed) {
      if (hasOpTag) score += 50
      if (hasEdTag && !hasOpTag) score -= 80
    } else if (intent.ed && !intent.op) {
      if (hasEdTag) score += 50
      if (hasOpTag && !hasEdTag) score -= 80
    }
    if (/ノンクレジット|creditless/i.test(tRaw)) score += 55
    if (/オープニング映像|エンディング映像|opening\s+video|ending\s+video|op映像|ed映像/i.test(tRaw)) score += 35
    if (/\bfull\b|フル/i.test(tRaw)) score -= 35
    if (isCompilation) score -= 85
  } else if (intent.full) {
    if (dur != null) {
      if (dur >= 170 && dur <= 540) score += 85
      else if (dur < 130) score -= 60
      else if (dur > 900) score -= 65
    }
    if (/\bfull\b|フル|complet[oa]|extended/i.test(tRaw)) score += 16
    if (/ノンクレジット|creditless/i.test(tRaw)) score -= 30
    if (isCompilation) score -= 80
  } else {
    if (isCompilation) score -= 55
    if ((c.isShort || (dur != null && dur > 0 && dur < 25)) && !intent.shortClip) score -= 50
    if (dur != null && dur >= 45 && dur <= 900) score += 18
    if (dur != null && dur > 1800) score -= 55
  }

  // Señales propias de AUDIO: preferir pista limpia de estudio sobre videoclips con actuación larga
  const isOfficialMv = /\b(official\s*(?:music\s*)?video|video\s*oficial|videoclip)\b/i.test(tNorm)
  const isStudioAudio = /\b(official\s*audio|audio\s*oficial|audio|visualizer|official\s*lyric|anime\s*lyric)\b/i.test(tNorm)

  if (isTopic && !intent.officialVideo) score += 45
  if (isStudioAudio && trustedChannel) score += 34
  else if (isOfficialMv && trustedChannel) score += 16
  if (isOfficialMv && dur != null && dur > 420 && !intent.officialVideo && !intent.albumOrLong) score -= 25

  return score
}

function pickBestVideo(candidates, query) {
  if (!candidates?.length) return null
  const intent = analyzeQueryIntent(query)
  const nonLive = intent.live ? candidates : candidates.filter(c => !c.isLive)
  const pool = nonLive.length ? nonLive : candidates
  let best = pool[0]
  let bestScore = -Infinity
  for (let i = 0; i < pool.length; i++) {
    const s = scoreAudioCandidate(pool[i], i, query, pool)
    if (s > bestScore) { bestScore = s; best = pool[i] }
  }
  return best
}

// Búsqueda directa en Innertube JSON de YouTube (~400ms): aporta insignias reales
// de Canal Oficial de Artista (🎵) y Verificado (✓), fragmentos de descripción y Shorts.
async function searchInnertube(query) {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept-language': 'es-419,es;q=0.9,en;q=0.8',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20261120.01.00', hl: 'es', gl: 'US' } },
        query,
      }),
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const items = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.videoRenderer?.videoId) {
        const vr = node.videoRenderer
        const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || ''
        const channel = vr.ownerText?.runs?.[0]?.text || vr.longBylineText?.runs?.[0]?.text || ''
        const badges = (vr.ownerBadges || []).map(b => b.metadataBadgeRenderer?.style || '')
        const isArtist = badges.some(s => s.includes('ARTIST'))
        const isVerified = isArtist || badges.some(s => s.includes('VERIFIED'))
        const timestamp = vr.lengthText?.simpleText || null
        const viewsRaw = vr.viewCountText?.simpleText || vr.viewCountText?.runs?.map(r => r.text).join('') || ''
        const ago = vr.publishedTimeText?.simpleText || null
        const description = vr.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') ||
          vr.descriptionSnippet?.runs?.map(r => r.text).join('') || ''
        const thumbs = vr.thumbnail?.thumbnails || []
        const thumb = thumbs.length ? thumbs[thumbs.length - 1]?.url : null
        const isLive = !timestamp && Boolean((vr.badges || []).some(b => /LIVE|VIVO|DIRECTO/i.test(b.metadataBadgeRenderer?.label || b.metadataBadgeRenderer?.style || '')))
        const isShort = Boolean(vr.navigationEndpoint?.reelWatchEndpoint)
        items.push({
          videoId: vr.videoId,
          url: `https://youtu.be/${vr.videoId}`,
          title,
          author: channel,
          channel,
          description,
          timestamp,
          durationSec: parseDurationSeconds(timestamp),
          views: parseViewsAny(viewsRaw),
          ago,
          thumbnail: thumb,
          image: thumb,
          isArtist,
          isVerified,
          isLive,
          isShort,
        })
        return
      }
      for (const v of Object.values(node)) walk(v)
    }
    walk(data)
    return items
  } catch {
    return []
  }
}

async function getVideoInfo(input, videoId) {
  if (videoId) {
    try {
      const info = await withTimeout(yts({ videoId }), 18000, 'YouTube no responde a la búsqueda desde el servidor.')
      if (info?.videoId) {
        return {
          ...info,
          videoId: info.videoId,
          url: `https://youtu.be/${info.videoId}`,
          image: info.thumbnail || info.image,
          isLive: Boolean(info.live || info.isLive),
        }
      }
    } catch {}
    const dl = await fetchYtDlpInfo(`https://youtu.be/${videoId}`)
    if (dl) return dl
    return { videoId, url: `https://youtu.be/${videoId}` }
  }

  const searchQuery = cleanSearchQuery(input)
  const [itRes, ytsRes] = await Promise.allSettled([
    searchInnertube(searchQuery),
    withTimeout(yts(searchQuery), 10000, 'yt-search timeout'),
  ])

  const byId = new Map()
  const order = []
  const mergeItem = (item) => {
    if (!item?.videoId) return
    const prev = byId.get(item.videoId)
    if (!prev) {
      byId.set(item.videoId, item)
      order.push(item.videoId)
    } else {
      byId.set(item.videoId, {
        ...prev,
        title: prev.title || item.title,
        author: prev.author || item.author,
        channel: prev.channel || item.channel,
        description: prev.description || item.description || '',
        timestamp: prev.timestamp || item.timestamp,
        durationSec: prev.durationSec ?? item.durationSec,
        views: prev.views ?? item.views,
        ago: prev.ago || item.ago,
        thumbnail: prev.thumbnail || item.thumbnail,
        image: prev.image || item.image,
        isArtist: Boolean(prev.isArtist || item.isArtist),
        isVerified: Boolean(prev.isVerified || item.isVerified),
        isLive: Boolean(prev.isLive || item.isLive),
        isShort: Boolean(prev.isShort || item.isShort),
      })
    }
  }

  if (itRes.status === 'fulfilled') {
    for (const item of itRes.value) mergeItem(item)
  }
  if (ytsRes.status === 'fulfilled' && ytsRes.value) {
    const search = ytsRes.value
    const pool = (search.videos || []).filter(v => v?.url || v?.videoId)
    if (!pool.length) pool.push(...(search.all || []).filter(v => v?.type === 'video' && (v?.url || v?.videoId)))
    for (const v of pool) {
      const id = v.videoId || getVideoId(v.url)
      mergeItem({
        videoId: id,
        url: id ? `https://youtu.be/${id}` : v.url,
        title: v.title,
        author: v.author?.name || v.author,
        channel: v.author?.name || v.author || '',
        description: v.description || '',
        timestamp: v.timestamp,
        durationSec: parseDurationSeconds(v.timestamp),
        views: parseViewsAny(v.views),
        ago: v.ago,
        thumbnail: v.thumbnail || v.image,
        image: v.image || v.thumbnail,
        isArtist: false,
        isVerified: false,
        isLive: Boolean(v.live || v.isLive || (!v.timestamp && v.seconds === 0)),
        isShort: /\/shorts\//i.test(v.url || ''),
      })
    }
  }

  const merged = order.map(id => byId.get(id))
  if (merged.length) {
    const best = pickBestVideo(merged, searchQuery)
    if (best) return best
  }

  await logPlay('búsqueda rápida sin resultados, probando yt-dlp')
  return await fetchYtDlpInfo(`ytsearch10:${searchQuery}`)
}

async function fetchYtDlpInfo(target) {
  try {
    const ytdlp = await ensureYtDlp()
    const cookies = await cookieArgs()
    const { stdout } = await execFileAsync(ytdlp, [
      '--dump-json', '--skip-download', '--no-playlist', '--no-warnings',
      '--socket-timeout', '15',
      '--js-runtimes', 'node',
      ...cookies,
      target,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
    const datas = []
    for (const line of String(stdout).trim().split('\n')) {
      if (!line.trim().startsWith('{')) continue
      try {
        const d = JSON.parse(line)
        if (d?.id) datas.push(d)
      } catch {}
    }
    if (!datas.length) return null
    let data = datas[0]
    const m = String(target).match(/^ytsearch\d*:(.+)$/i)
    if (m && datas.length > 1) {
      const cands = datas.map(d => ({
        videoId: d.id,
        title: d.title,
        channel: d.channel || d.uploader || '',
        description: d.description || '',
        durationSec: Number(d.duration),
        views: Number(d.view_count),
        isArtist: Boolean(d.artist || d.track),
        isVerified: Boolean(d.channel_is_verified),
        isLive: Boolean(d.is_live || d.live_status === 'is_live'),
        isShort: Boolean(d.aspect_ratio && d.aspect_ratio < 0.8),
        data: d,
      }))
      data = pickBestVideo(cands, m[1])?.data || datas[0]
    }
    if (!data?.id) return null
    const durationSec = Number(data.duration)
    const views = Number(data.view_count)
    const ts = Number(data.timestamp || data.release_timestamp)
    return {
      videoId: data.id,
      url: `https://youtu.be/${data.id}`,
      title: data.title || null,
      author: data.uploader || data.channel || null,
      timestamp: Number.isFinite(durationSec) && durationSec > 0 ? formatDuration(durationSec) : null,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      views: Number.isFinite(views) ? views : null,
      ago: Number.isFinite(ts) && ts > 0 ? relativeTimeEs(ts) : null,
      thumbnail: data.thumbnail || null,
      image: data.thumbnail || null,
      isLive: Boolean(data.is_live || data.live_status === 'is_live'),
      stats: {
        views: Number.isFinite(views) && views > 0 ? views : null,
        timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
      },
    }
  } catch {
    return null
  }
}

// Descarga o verifica yt-dlp una sola vez por proceso (atómico para evitar ETXTBSY).
async function ensureYtDlp() {
  if (ytdlpState.verifiedPath) return ytdlpState.verifiedPath
  if (ytdlpState.initPromise) return ytdlpState.initPromise

  ytdlpState.initPromise = (async () => {
    for (const candidate of [YTDLP_PATH, 'yt-dlp']) {
      try {
        if (candidate === YTDLP_PATH) await fs.access(candidate, fs.constants.X_OK)
        await execFileAsync(candidate, ['--version'], { timeout: 15000 })
        ytdlpState.verifiedPath = candidate
        return candidate
      } catch {}
    }

    let lastError = null
    for (const url of YTDLP_URLS) {
      const tmpBin = `${YTDLP_PATH}.tmp.${process.pid}.${Date.now()}`
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length < 1_000_000 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
          throw new Error('El archivo descargado no es un binario ELF válido.')
        }
        await fs.mkdir(path.dirname(YTDLP_PATH), { recursive: true })
        await fs.writeFile(tmpBin, buffer, { mode: 0o755 })
        await fs.rename(tmpBin, YTDLP_PATH)
        await execFileAsync(YTDLP_PATH, ['--version'], { timeout: 15000 })
        ytdlpState.verifiedPath = YTDLP_PATH
        return YTDLP_PATH
      } catch (error) {
        lastError = error
        await fs.rm(tmpBin, { force: true }).catch(() => {})
      }
    }
    throw new Error(`No pude preparar yt-dlp: ${lastError?.message || 'descarga fallida'}.`)
  })().finally(() => {
    ytdlpState.initPromise = null
  })

  return ytdlpState.initPromise
}

async function getVideoStats(url) {
  try {
    const ytdlp = await ensureYtDlp()
    const cookies = await cookieArgs()
    const { stdout } = await execFileAsync(ytdlp, [
      '--print', '%(view_count)s|%(timestamp)s',
      '--skip-download', '--no-playlist', '--no-warnings',
      '--socket-timeout', '10',
      '--js-runtimes', 'node',
      ...cookies,
      url,
    ], { timeout: 12000, maxBuffer: 1024 * 1024 })
    const [views, timestamp] = String(stdout).trim().split('\n')[0].split('|')
    const v = Number(views)
    const t = Number(timestamp)
    return {
      views: Number.isFinite(v) && v > 0 ? v : null,
      timestamp: Number.isFinite(t) && t > 0 ? t : null,
    }
  } catch {
    return { views: null, timestamp: null }
  }
}

// Normaliza cualquier audio descargado (m4a, webm, opus, mp4) a M4A (AAC-LC)
// compatible con WhatsApp en Android e iOS, con faststart y metadatos/portada JPEG.
async function finalizeAudioM4a(inputPath, tmpDir, { title, channel, coverBuffer, targetBitrateKbps = 128 }) {
  const probed = await probeAudioInfo(inputPath)
  const canCopyAudio = probed.acodec === 'aac' && !probed.hasVideo && path.extname(inputPath).toLowerCase() === '.m4a'
  const outPath = path.join(tmpDir, 'final-audio.m4a')
  const coverPath = path.join(tmpDir, 'cover.jpg')

  let hasCover = false
  if (coverBuffer?.length) {
    try {
      await fs.writeFile(coverPath, coverBuffer)
      hasCover = true
    } catch {}
  }

  const runMux = async (withCover) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath]
    if (withCover) args.push('-i', coverPath)
    args.push('-map', '0:a:0')
    if (withCover) args.push('-map', '1:v:0')
    if (canCopyAudio) {
      args.push('-c:a', 'copy')
    } else {
      args.push('-c:a', 'aac', '-b:a', `${targetBitrateKbps}k`, '-ar', '44100')
    }
    if (withCover) {
      args.push(
        '-c:v', 'copy',
        '-metadata:s:v', 'title=Album cover',
        '-metadata:s:v', 'comment=Cover (front)',
        '-disposition:v', 'attached_pic',
      )
    } else {
      args.push('-vn')
    }
    if (title) args.push('-metadata', `title=${title}`)
    if (channel) {
      args.push('-metadata', `artist=${channel}`, '-metadata', `album_artist=${channel}`)
    }
    args.push('-movflags', '+faststart', outPath)
    await execFileAsync(FFMPEG_BIN, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
    const st = await fs.stat(outPath)
    if (!st.size) throw new Error('salida vacía')
    return { filePath: outPath, size: st.size, ext: 'm4a', seconds: probed.durationSec, tagged: withCover }
  }

  if (hasCover) {
    try {
      return await runMux(true)
    } catch {}
  }
  try {
    return await runMux(false)
  } catch {
    const st = await fs.stat(inputPath)
    const ext = path.extname(inputPath).slice(1).toLowerCase() || 'm4a'
    return { filePath: inputPath, size: st.size, ext, seconds: probed.durationSec, tagged: false }
  }
}

async function downloadWithYtDlp(ytdlp, url, attemptDir, extraArgs, { targetBitrateKbps, signal }) {
  const outTemplate = path.join(attemptDir, 'audio.%(ext)s')
  const cookies = await cookieArgs()
  const formatSelector = targetBitrateKbps <= 96
    ? 'ba[ext=m4a][abr<=96]/ba[abr<=96]/ba[ext=m4a][abr<=128]/ba[ext=m4a]/ba/b[height<=360]'
    : 'ba[ext=m4a][abr<=140]/ba[ext=m4a]/ba[acodec^=mp4a]/ba/b[height<=360]'

  await execFileAsync(ytdlp, [
    '-f', formatSelector,
    '--js-runtimes', 'node',
    '--no-playlist', '--no-warnings', '--geo-bypass',
    '--socket-timeout', '20',
    '--retries', '2',
    '--fragment-retries', '2',
    '--abort-on-unavailable-fragments',
    '--concurrent-fragments', '4',
    ...ffmpegLocationArgs(),
    ...cookies,
    ...extraArgs,
    '-o', outTemplate,
    url,
  ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024, signal })

  const entries = await fs.readdir(attemptDir)
  const file = entries.find(f =>
    f.startsWith('audio.') &&
    !/\.(part|ytdl|temp)$/i.test(f) &&
    !/\.f\d+\./i.test(f),
  )
  if (!file) throw new Error('yt-dlp terminó sin dejar el audio.')
  const rawPath = path.join(attemptDir, file)
  const rawStat = await fs.stat(rawPath)
  if (rawStat.size < 1024) throw new Error('yt-dlp dejó un archivo de audio incompleto.')
  return rawPath
}

async function streamToBuffer(stream, maxSize, signal) {
  const chunks = []
  let total = 0
  const onAbort = () => { try { stream.destroy(new Error('Tiempo agotado leyendo stream.')) } catch {} }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of stream) {
      total += chunk.length
      if (total > maxSize) throw new Error('El audio pesa más del límite de 64 MB.')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

function formatViewsCompact(views) {
  const n = Number(views || 0)
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

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

// Convierte tanto formatos largos ("7 months ago", "Streamed 2 days ago")
// como abreviados de YouTube 2026 ("7mo ago", "2d ago", "5h ago", "1y ago").
function agoToEs(ago) {
  const raw = String(ago || '').trim()
  if (!raw) return null
  if (/^hace\s+/i.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1)
  const m = raw.match(/(\d+)\s*(months?|mo|years?|yrs?|y|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i)
  if (!m) return raw
  const n = Number(m[1])
  const token = m[2].toLowerCase()
  let key = 'second'
  if (token.startsWith('mo')) key = 'month'
  else if (token.startsWith('y')) key = 'year'
  else if (token.startsWith('w')) key = 'week'
  else if (token.startsWith('d')) key = 'day'
  else if (token.startsWith('h')) key = 'hour'
  else if (token.startsWith('m')) key = 'minute'
  const unit = {
    second: ['segundo', 'segundos'],
    minute: ['minuto', 'minutos'],
    hour: ['hora', 'horas'],
    day: ['día', 'días'],
    week: ['semana', 'semanas'],
    month: ['mes', 'meses'],
    year: ['año', 'años'],
  }[key]
  return `Hace ${n} ${n === 1 ? unit[0] : unit[1]}`
}

function formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function parseDurationSeconds(timestamp) {
  const parts = String(timestamp || '').trim().split(':').map(Number)
  if (!parts.length || !timestamp || parts.some(Number.isNaN)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

function sanitizeFileName(name = 'audio') {
  return String(name)
    .replace(/\.(mp3|m4a|webm|opus|ogg|mp4)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio'
}

function mimeFor(ext) {
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'opus') return 'audio/ogg; codecs=opus'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'webm') return 'audio/webm'
  return 'audio/mp4'
}

async function getAudio(url, { title, channel, durationSec, thumbBundlePromise, signal, voice = false }) {
  const errors = []
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-play-'))
  const targetBitrateKbps = durationSec && durationSec > 3000 ? 96 : 128
  await logPlay('getAudio inicio:', url, `(${targetBitrateKbps}kbps)`)

  let rawAudioPath = null
  try {
    const ytdlp = await ensureYtDlp().catch(err => {
      errors.push(`yt-dlp init: ${err.message}`)
      return null
    })

    if (ytdlp) {
      const clients = [
        ['web', []],
        ['android_vr', ['--extractor-args', 'youtube:player_client=android_vr']],
        ['mweb', ['--extractor-args', 'youtube:player_client=mweb']],
        ['tv_embedded', ['--extractor-args', 'youtube:player_client=tv_embedded']],
      ]
      for (let i = 0; i < clients.length && !rawAudioPath; i++) {
        if (signal?.aborted) throw new Error('Descarga cancelada por límite de tiempo.')
        const [clientName, extraArgs] = clients[i]
        const attemptDir = path.join(tmpDir, `attempt-${i}`)
        await fs.mkdir(attemptDir, { recursive: true })
        try {
          rawAudioPath = await downloadWithYtDlp(ytdlp, url, attemptDir, extraArgs, { targetBitrateKbps, signal })
          await logPlay(`yt-dlp ${clientName} OK:`, path.basename(rawAudioPath))
        } catch (error) {
          errors.push(`${clientName}: ${error.message}`)
          await logPlay(`yt-dlp ${clientName} falló:`, String(error.message).slice(0, 200))
          await fs.rm(attemptDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    }

    if (!rawAudioPath) {
      if (signal?.aborted) throw new Error('Descarga cancelada por límite de tiempo.')
      try {
        await logPlay('play-dl inicio')
        const s = await withTimeout(play.stream(url, { quality: 2 }), 45000, 'play-dl no respondió en 45s.')
        const buffer = await withTimeout(streamToBuffer(s.stream, MAX_AUDIO_SIZE, signal), 60000, 'play-dl dejó de mandar datos.', () => {
          try { s.stream?.destroy() } catch {}
        })
        const ext = s.type === 'opus' ? 'opus' : (s.type === 'mp4' ? 'm4a' : 'webm')
        rawAudioPath = path.join(tmpDir, `playdl.${ext}`)
        await fs.writeFile(rawAudioPath, buffer)
        await logPlay('play-dl OK:', ext)
      } catch (error) {
        errors.push(`play-dl: ${error.message}`)
        await logPlay('play-dl falló:', String(error.message).slice(0, 200))
      }
    }

    if (!rawAudioPath) {
      await logPlay('getAudio sin éxito:', errors.join(' | ').slice(0, 300))
      throw new Error('No pude descargar el audio desde YouTube en este momento.')
    }

    const thumbBundle = await Promise.resolve(thumbBundlePromise).catch(() => null)
    const finalized = await finalizeAudioM4a(rawAudioPath, tmpDir, {
      title,
      channel: channel || 'YouTube',
      coverBuffer: thumbBundle?.coverBuffer || null,
      targetBitrateKbps,
    })

    if (finalized.size > MAX_AUDIO_SIZE) {
      throw new Error(`El audio pesa ${(finalized.size / 1024 / 1024).toFixed(1)} MB, más del límite de 64 MB.`)
    }
    if (finalized.size < 1024) {
      throw new Error('El archivo de audio quedó vacío o corrupto.')
    }

    await logPlay(finalized.tagged ? 'metadatos incrustados (título + portada JPEG)' : 'audio normalizado a M4A')

    if (voice) {
      // Nota de audio: Opus en contenedor OGG, el formato nativo de WhatsApp para ptt.
      const oggPath = path.join(tmpDir, 'voice.ogg')
      await execFileAsync(FFMPEG_BIN, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', finalized.filePath,
        '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000',
        '-application', 'audio', '-f', 'ogg', oggPath,
      ], { timeout: 120000, signal })
      const oggBuffer = await fs.readFile(oggPath)
      if (oggBuffer.length < 1024) throw new Error('No pude convertir el audio a nota de voz.')
      return {
        buffer: oggBuffer,
        ext: 'ogg',
        seconds: finalized.seconds || durationSec || null,
        name: `${sanitizeFileName(title)}.ogg`,
      }
    }

    const buffer = await fs.readFile(finalized.filePath)
    return {
      buffer,
      ext: finalized.ext,
      seconds: finalized.seconds || durationSec || null,
      name: `${sanitizeFileName(title)}.${finalized.ext}`,
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export default {
  command: ['play', 'mp3', 'ytmp3', 'ytaudio', 'playaudio', 'ytmp3doc'],
  category: 'downloads',
  description: 'Descarga el audio de un video de YouTube. Uso: `play <nombre o enlace>. `playaudio` lo envía como nota de audio sin ondas y `ytmp3doc` como documento.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const cmdName = String(command || '').toLowerCase()
    const voiceMode = cmdName === 'playaudio'
    const docMode = cmdName === 'ytmp3doc'
    const usedName = voiceMode ? 'playaudio' : docMode ? 'ytmp3doc' : 'play'
    const quotedUrl = !args?.[0] ? extractYTUrlFromText(msg.quoted?.text || msg.quoted?.body || '') : null
    const input = (args?.join(' ').trim() || quotedUrl || '').trim()
    if (!input) {
      return msg.reply(`*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✐ ᴜsᴏ » *${usedPrefix}${usedName} <nombre o enlace>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}${usedName} despacito_`)
    }

    await logPlay('play inicio:', input.slice(0, 100))
    await msg.react?.('⏳').catch(() => {})

    const abortController = new AbortController()
    try {
      let videoId = getVideoId(input)
      const query = videoId ? `https://youtu.be/${videoId}` : input
      let url = query
      let title = 'audio'
      let channel = 'YouTube'
      let durationSec = null
      let thumbBundlePromise = Promise.resolve(null)
      let cardPromise = Promise.resolve()

      try {
        const info = await getVideoInfo(query, videoId)
        await logPlay('info:', info?.title ? `título="${String(info.title).slice(0, 80)}"` : (info?.url ? 'solo URL, sin título' : 'sin resultado'), 'vistas=', info?.views, 'ago=', info?.ago)
        if (info?.isLive) {
          await msg.react?.('❌').catch(() => {})
          return msg.reply('*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *No se pueden descargar transmisiones en vivo activas.*')
        }
        if (info?.videoId) videoId = info.videoId
        if (info?.title) {
          url = info.url || (videoId ? `https://youtu.be/${videoId}` : url)
          title = info.title || title
          const rawThumb = info.image || info.thumbnail || null
          channel = info.author?.name || info.author || 'YouTube'
          durationSec = info.durationSec ?? parseDurationSeconds(info.timestamp)
          const bitrateLabel = durationSec && durationSec > 3000 ? 96 : 128
          const sizeMB = durationSec ? (bitrateLabel * durationSec / 8 / 1024).toFixed(2) : null

          thumbBundlePromise = prepareThumbBundle(videoId || getVideoId(url), rawThumb)
          const statsPromise = info.stats
            ? Promise.resolve(info.stats)
            : getVideoStats(url).catch(() => ({ views: null, timestamp: null }))

          cardPromise = (async () => {
            try {
              const [thumbBundle, stats] = await Promise.all([
                thumbBundlePromise,
                withTimeout(statsPromise, 10000, 'stats').catch(() => ({ views: null, timestamp: null })),
              ])
              const views = stats.views ?? info.views
              const lanzamiento = stats.timestamp ? relativeTimeEs(stats.timestamp) : agoToEs(info.ago)
              const durationText = info.timestamp || (durationSec ? formatDuration(durationSec) : 'Desconocida')
              const infoMessage = `*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ❀ ᴛíᴛᴜʟᴏ » *${title}*\n> ✐ ᴄᴀɴᴀʟ » *${channel || 'Desconocido'}*\n> ⴵ ᴅᴜʀᴀᴄɪóɴ » *${durationText}* │ ✧ *${views != null ? formatViewsCompact(views) : 'Desconocido'}* vistas\n> ✰ ᴄᴀʟɪᴅᴀᴅ » *${bitrateLabel} kbps* │ ❒ *${sizeMB ? `${sizeMB} MB` : 'Desconocido'}*\n> ⊞ ʟᴀɴᴢᴀᴍɪᴇɴᴛᴏ » *${lanzamiento || 'Desconocido'}*\n> 🜸 ʟɪɴᴋ » _${url}_`

              const sendOpts = { quoted: msg, ephemeralExpiration: msg.expiration }
              if (thumbBundle?.cardBuffer) {
                await withTimeout(sock.sendMessage(msg.chat, {
                  image: thumbBundle.cardBuffer,
                  mimetype: 'image/jpeg',
                  width: thumbBundle.width,
                  height: thumbBundle.height,
                  ...(thumbBundle.microBuffer ? { jpegThumbnail: thumbBundle.microBuffer } : {}),
                  caption: infoMessage,
                }, sendOpts), 20000, 'La tarjeta de info no se pudo enviar.')
                await logPlay('tarjeta enviada (HD JPEG + jpegThumbnail)')
              } else if (rawThumb) {
                await withTimeout(sock.sendMessage(msg.chat, { image: { url: rawThumb }, caption: infoMessage }, sendOpts), 20000, 'La tarjeta de info no se pudo enviar.')
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
          const resolvedId = videoId || getVideoId(url)
          if (resolvedId) thumbBundlePromise = prepareThumbBundle(resolvedId, null)
        }
      } catch (error) {
        await logPlay('info falló:', String(error?.message || error).slice(0, 200))
        console.error('[play] no pude obtener la info del video:', error?.message || error)
        if (!videoId) {
          await msg.react?.('❌').catch(() => {})
          return msg.reply('*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *No pude buscar en YouTube desde el servidor. Prueba pegando el enlace directo del video.*')
        }
        url = `https://youtu.be/${videoId}`
        thumbBundlePromise = prepareThumbBundle(videoId, null)
      }

      if (!isYTUrl(url)) {
        await msg.react?.('❌').catch(() => {})
        return msg.reply('*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *No encontré un video válido de YouTube para eso.*')
      }

      const audio = await withTimeout(
        getAudio(url, { title, channel, durationSec, thumbBundlePromise, signal: abortController.signal, voice: voiceMode }),
        240000,
        'La descarga del audio tardó demasiado (4 min). Prueba con otro video o más tarde.',
        () => abortController.abort(),
      )

      await Promise.race([cardPromise, new Promise(resolve => setTimeout(resolve, 2500))])
      await logPlay('audio listo, enviando:', audio.name)

      const sendOptions = {
        quoted: msg,
        ephemeralExpiration: msg.expiration,
        mediaUploadTimeoutMs: 120000,
      }

      if (voiceMode) {
        // Nota de audio de WhatsApp (ptt) con waveform vacío: burbuja de audio nativa sin las ondas.
        await sock.sendMessage(msg.chat, {
          audio: audio.buffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
          waveform: new Uint8Array(0),
          ...(audio.seconds ? { seconds: audio.seconds } : {}),
        }, sendOptions)
      } else if (docMode) {
        // Documento con el JPG de la portada como miniatura.
        const thumbBundle = await Promise.resolve(thumbBundlePromise).catch(() => null)
        const docDims = thumbBundle?.microBuffer ? fitMaxEdge(thumbBundle.width, thumbBundle.height, WA_MICRO_THUMB_MAX_EDGE) : null
        await sock.sendMessage(msg.chat, {
          document: audio.buffer,
          fileName: audio.name,
          mimetype: mimeFor(audio.ext),
          ...(docDims ? {
            jpegThumbnail: thumbBundle.microBuffer,
            thumbnailWidth: docDims.width,
            thumbnailHeight: docDims.height,
          } : {}),
        }, sendOptions)
      } else {
        // Se envía sin externalAdReply encima para mantener limpia la burbuja de audio;
        // el título, artista y portada JPEG real van incrustados dentro del archivo M4A.
        await sock.sendMessage(msg.chat, {
          audio: audio.buffer,
          fileName: audio.name,
          mimetype: mimeFor(audio.ext),
          ...(audio.seconds ? { seconds: audio.seconds } : {}),
        }, sendOptions)
      }

      await logPlay('audio enviado OK')
      await msg.react?.('✅').catch(() => {})
    } catch (error) {
      abortController.abort()
      await logPlay('play error:', String(error?.message || error).slice(0, 300))
      console.error('[play] error:', error?.stack || error)
      await msg.react?.('❌').catch(() => {})
      await msg.reply(`*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗔𝗨𝗗𝗜𝗢*\n> ✖ ᴇʀʀᴏʀ » *${error?.message || 'No pude descargar el audio. Inténtalo más tarde.'}*`)
    }
  },
}
