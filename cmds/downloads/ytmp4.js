// ytmp4.js — Descargar el video (MP4) de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs de terceros: busca con yt-search (scraping)
// y descarga con yt-dlp (scrapea YouTube directo, sin API key).
// yt-dlp se descarga automáticamente a lib/yt-dlp la primera vez (ELF
// standalone para x64 o arm64) de forma atómica y se reutiliza.
// Fallbacks de descarga: 1) yt-dlp web/default, 2) android_vr, 3) mweb,
// 4) tv_embedded, 5) respaldo 360p / transcodificación H.264+AAC faststart.
// Incluye generación de miniatura HD 16:9 para la tarjeta y miniatura nativa
// de WhatsApp (jpegThumbnail baseline <=96px + width/height/seconds reales)
// para que el preview del video y documento se vea nítido antes de descargar.

import yts from 'yt-search'
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

const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50 MB: por encima se envía como documento
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB: límite máximo del comando
const WA_MICRO_THUMB_MAX_EDGE = 96
const WA_MICRO_THUMB_MAX_BYTES = 8 * 1024

const ytdlpState = globalThis.__rembotYtDlpState ??= { verifiedPath: null, initPromise: null }

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

const PLAY_DEBUG_LOG = path.join(BOT_ROOT, 'lib', 'system', 'play-debug.log')
async function logPlay(...parts) {
  try {
    const stat = await fs.stat(PLAY_DEBUG_LOG).catch(() => null)
    if (stat && stat.size > 200 * 1024) await fs.rm(PLAY_DEBUG_LOG, { force: true }).catch(() => {})
    await fs.mkdir(path.dirname(PLAY_DEBUG_LOG), { recursive: true })
    await fs.appendFile(PLAY_DEBUG_LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch {}
}

const YT_URL_RE = /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"']+/i

const isYTUrl = (url = '') =>
  /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/.+$/i.test(String(url || '').trim())

// Extrae el ID solo desde enlaces reales de YouTube (watch, youtu.be, shorts,
// live, m.youtube.com, music.youtube.com), sin confundir palabras de 11 letras.
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

async function probeImageDimensions(filePath) {
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

// Procesa la portada de YouTube: elimina barras negras 4:3, convierte WebP/PNG
// a JPEG baseline real 16:9 HD y crea el jpegThumbnail compacto para la ficha.
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
      }
    } catch {}
  }

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
    const dims = await probeImageDimensions(cardPath)
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

// Genera el jpegThumbnail del VIDEO (videoMessage / documentMessage) como lo hace WhatsApp:
// a partir de un fotograma real del propio MP4, NUNCA de la portada de YouTube de la tarjeta.
// - Toma un fotograma cercano al inicio y, si es negro/vacío (fundido inicial), reintenta más adentro.
// - Respeta la proporción exacta del video (ej. 100x56 en 16:9 o 56x100 en Shorts 9:16).
// - JPEG baseline 4:2:0 con lado mayor <=WA_MICRO_THUMB_MAX_EDGE y <8 KB (límite de Android/iOS).
async function buildVideoWaThumbnail(videoPath, tmpDir, { width, height, durationSec }) {
  const target = fitMaxEdge(width || 854, height || 480, WA_MICRO_THUMB_MAX_EDGE)
  const sharp = await loadSharp()
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 0

  const seeks = dur > 3
    ? [
        { ss: Math.min(1, dur * 0.1), pick: 12 },
        { ss: Math.min(Math.max(2, dur * 0.2), 15), pick: 30 },
        { ss: Math.min(Math.max(4, dur * 0.4), 40), pick: 30 },
      ]
    : [{ ss: 0, pick: 8 }]

  let attemptIdx = 0
  let lastBuffer = null
  for (const { ss, pick } of seeks) {
    attemptIdx += 1
    try {
      const frame = path.join(tmpDir, `wa-frame-${attemptIdx}.jpg`)
      await execFileAsync(FFMPEG_BIN, [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...(ss > 0 ? ['-ss', ss.toFixed(2)] : []),
        '-i', videoPath,
        '-vf', `thumbnail=${pick},scale='min(640,iw)':-2:flags=lanczos,format=yuvj420p`,
        '-frames:v', '1', '-update', '1', '-q:v', '3', frame,
      ], { timeout: 20000 })
      const frameBuf = await fs.readFile(frame)
      if (!frameBuf?.length) continue

      if (sharp) {
        const stats = await sharp(frameBuf).stats()
        const mean = stats.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3
        const dev = stats.channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3
        const blank = mean < 14 || dev < 6
        const make = quality => sharp(frameBuf)
          .resize({ width: target.width, height: target.height, fit: 'fill', kernel: 'lanczos3' })
          .sharpen(0.45)
          .jpeg({ quality, progressive: false, mozjpeg: false, chromaSubsampling: '4:2:0' })
          .toBuffer()
        let buffer = await make(78)
        if (buffer.length > WA_MICRO_THUMB_MAX_BYTES) buffer = await make(58)
        if (!buffer.length || buffer.length > WA_MICRO_THUMB_MAX_BYTES) continue
        lastBuffer = { buffer, width: target.width, height: target.height }
        if (!blank) return lastBuffer
      } else {
        const out = path.join(tmpDir, `wa-vthumb-${attemptIdx}.jpg`)
        await execFileAsync(FFMPEG_BIN, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', frame,
          '-vf', `scale=${target.width}:${target.height}:flags=lanczos,unsharp=3:3:0.35:3:3:0.0,format=yuvj420p`,
          '-frames:v', '1', '-update', '1', '-q:v', '5', out,
        ], { timeout: 12000 })
        const buffer = await fs.readFile(out)
        if (buffer?.length && buffer.length <= WA_MICRO_THUMB_MAX_BYTES) {
          return { buffer, width: target.width, height: target.height }
        }
      }
    } catch {}
  }
  return lastBuffer
}

const ROMAN_MAP = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12' }

const BASE_STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'y', 'o', 'u', 'a', 'e',
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'and', 'or', 'from',
  'feat', 'ft', 'prod', 'x', 'vs',
  'oficial', 'official', 'video', 'audio', 'music', 'musica', 'cancion', 'song', 'hd', '4k', 'hq', '1080p', '720p', 'mv',
])

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
    albumOrLong: /\b(album|playlist|mix|compilacion|compilation|megamix|set|1\s*hora|1\s*hour|\d+\s*h(?:oras?|ours?)?|podcast|episodio|episode|capitulo|pelicula|movie|documental|gameplay|walkthrough|conferencia)\b|todos los/i.test(qn),
    shortClip: /\b(shorts?|tiktok|reel|meme|clip|estado|status|edit|amv|mmv)\b/i.test(qn),
    tutorial: /\b(tutorial|curso|clase|como\s+hacer|como\s+tocar|how\s+to|guia|aprende|aprender|acordes|chords)\b/i.test(qn),
    reaction: /\b(reaccion|reaction|reacting\s+to|first\s+time|review|analisis|critica|opinion)\b/i.test(qn),
  }
}

// Puntúa cualquier video o música para encontrar el mejor VIDEO real (`play2`):
// prioriza videoclips oficiales, visualizers, tráilers y canales verificados/artistas (🎵/✓),
// evita portadas estáticas "- Topic" o fondos de letra de terceros cuando existe el video real,
// distingue OP de ED y tutoriales de reacciones, y respeta versiones full, covers, remixes y mixes.
function scoreVideoCandidate(c, idx, query, allCands) {
  const intent = analyzeQueryIntent(query)
  const tRaw = String(c.title || '')
  const chRaw = String(c.channel || '')
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
  const trustedChannel = Boolean(c.isArtist || isVevo || c.isVerified || matchesTitleArtist || isKnownPublisher)

  if (c.isArtist || isVevo) score += 55
  else if (matchesTitleArtist) score += 42
  else if (c.isVerified) score += 24
  else if (isKnownPublisher) score += 22

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
  if (intent.live) { if (isLivePerf || c.isLive) score += 60 } else if (isLivePerf) score -= 30

  const isLyricVid = /\b(lyrics?|letra|lyric\s+video|video\s+lyric|anime\s+lyric|sub\s+espanol|traducid[oa])\b/i.test(tNorm)
  if (intent.lyrics && isLyricVid) score += 45

  const isCompilation = /\b(playlist|album|compilacion|compilation|megamix|todos\s+los|all\s+(?:openings|endings|songs)|1\s*hora|1\s*hour|\b1h\b|\bmix\b|full\s+album|full\s+ost)\b/i.test(tNorm)

  if (dur != null && dur > 5400) score -= 180
  else if (dur != null && dur > 3600 && !intent.albumOrLong) score -= 160

  const hasOpTag = /オープニング|opening|\bop\s*\d*\b/i.test(tRaw)
  const hasEdTag = /エンディング|ending|\bed\s*\d*\b/i.test(tRaw)

  if (intent.albumOrLong || intent.tutorial) {
    if (isCompilation && intent.albumOrLong) score += 65
    if (dur != null) {
      if (dur >= 600 && dur <= 3600) score += 65
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

  // Señales propias de VIDEO: priorizar videoclip/tráiler/visualizer real sobre imagen fija "- Topic"
  const isOfficialMv = /\b(official\s*(?:music\s*)?video|video\s*oficial|videoclip|official\s*trailer|trailer\s*(?:de\s*lanzamiento|oficial))\b/i.test(tNorm)
  if (isOfficialMv && trustedChannel) score += 38
  else if (/\bvisualizer\b/i.test(tNorm) && trustedChannel) score += 24

  if (isTopic && !intent.officialAudio) score -= 40
  if (isLyricVid && !intent.lyrics && !c.isArtist && !matchesTitleArtist) score -= 22
  else if (isLyricVid && !intent.lyrics && (c.isArtist || matchesTitleArtist)) score -= 8

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
    const s = scoreVideoCandidate(pool[i], i, query, pool)
    if (s > bestScore) { bestScore = s; best = pool[i] }
  }
  return best
}

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
        const duration = vr.lengthText?.simpleText || null
        const viewsRaw = vr.viewCountText?.simpleText || vr.viewCountText?.runs?.map(r => r.text).join('') || ''
        const ago = vr.publishedTimeText?.simpleText || null
        const description = vr.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') ||
          vr.descriptionSnippet?.runs?.map(r => r.text).join('') || ''
        const thumbs = vr.thumbnail?.thumbnails || []
        const thumb = thumbs.length ? thumbs[thumbs.length - 1]?.url : null
        const isLive = !duration && Boolean((vr.badges || []).some(b => /LIVE|VIVO|DIRECTO/i.test(b.metadataBadgeRenderer?.label || b.metadataBadgeRenderer?.style || '')))
        const isShort = Boolean(vr.navigationEndpoint?.reelWatchEndpoint)
        items.push({
          videoId: vr.videoId,
          url: `https://youtu.be/${vr.videoId}`,
          title,
          channel,
          description,
          duration,
          durationSec: parseDurationSeconds(duration),
          views: parseViewsAny(viewsRaw),
          ago,
          thumbnail: thumb,
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

async function getVideoMeta(input) {
  const id = getVideoId(input)
  if (id) {
    try {
      const info = await withTimeout(yts({ videoId: id }), 18000, 'YouTube no responde a la búsqueda desde el servidor.')
      if (info?.videoId) {
        return {
          videoId: info.videoId,
          url: `https://youtu.be/${info.videoId}`,
          title: info.title,
          channel: info.author?.name || info.author,
          duration: info.timestamp,
          durationSec: parseDurationSeconds(info.timestamp),
          views: parseViewsAny(info.views),
          thumbnail: info.thumbnail || info.image,
          ago: info.ago,
          isLive: Boolean(info.live || info.isLive),
        }
      }
    } catch {}
    const dl = await fetchYtDlpInfo(`https://youtu.be/${id}`)
    if (dl) {
      return {
        videoId: dl.videoId || id,
        url: dl.url,
        title: dl.title,
        channel: dl.author,
        duration: dl.timestamp,
        durationSec: dl.durationSec,
        views: dl.views,
        thumbnail: dl.thumbnail,
        ago: dl.ago,
        isLive: dl.isLive,
        stats: dl.stats,
      }
    }
    return { videoId: id, url: `https://youtu.be/${id}`, title: null, channel: null, duration: null, durationSec: null, views: null, thumbnail: null, ago: null, isLive: false }
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
        channel: prev.channel || item.channel,
        description: prev.description || item.description || '',
        duration: prev.duration || item.duration,
        durationSec: prev.durationSec ?? item.durationSec,
        views: prev.views ?? item.views,
        ago: prev.ago || item.ago,
        thumbnail: prev.thumbnail || item.thumbnail,
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
      const vid = v.videoId || getVideoId(v.url)
      mergeItem({
        videoId: vid,
        title: v.title,
        url: vid ? `https://youtu.be/${vid}` : v.url,
        channel: v.author?.name || v.author || '',
        description: v.description || '',
        duration: v.timestamp,
        durationSec: parseDurationSeconds(v.timestamp),
        views: parseViewsAny(v.views),
        thumbnail: v.thumbnail || v.image,
        ago: v.ago,
        isArtist: false,
        isVerified: false,
        isLive: Boolean(v.live || v.isLive || (!v.timestamp && v.seconds === 0)),
        isShort: /\/shorts\//i.test(v.url || ''),
      })
    }
  }

  const merged = order.map(vid => byId.get(vid))
  if (merged.length) {
    const best = pickBestVideo(merged, searchQuery)
    if (best) return best
  }

  const dl = await fetchYtDlpInfo(`ytsearch10:${searchQuery}`)
  if (dl) {
    return {
      videoId: dl.videoId,
      url: dl.url,
      title: dl.title,
      channel: dl.author,
      duration: dl.timestamp,
      durationSec: dl.durationSec,
      views: dl.views,
      thumbnail: dl.thumbnail,
      ago: dl.ago,
      isLive: dl.isLive,
      stats: dl.stats,
    }
  }
  throw new Error('No encontré un video válido de YouTube para eso.')
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

// Elige el nivel de calidad óptimo según la duración:
// - Videos cortos (<=5 min): 720p HD H.264 si pesa <44 MB (con respaldo a 480p).
// - Videos medios (5–20 min): 480p H.264.
// - Videos largos (>20 min): 360p H.264 para no pasar el límite de 100 MB.
function selectQualityTier(durationSec) {
  if (durationSec && durationSec > 0 && durationSec <= 300) {
    return {
      label: '720p',
      estKbps: 1900,
      format: '(bv*[height<=720][vcodec^=avc1][filesize<44M]/bv*[height<=720][vcodec^=avc1][filesize_approx<44M]/bv*[height<=480][vcodec^=avc1])+(ba[ext=m4a][abr<=160]/ba[ext=m4a]/ba[acodec^=mp4a]/ba)/b[height<=720][vcodec^=avc1]/b[height<=480][vcodec^=avc1]',
    }
  }
  if (durationSec && durationSec > 1200) {
    return {
      label: '360p',
      estKbps: 850,
      format: '(bv*[height<=360][vcodec^=avc1])+(ba[ext=m4a][abr<=128]/ba[ext=m4a]/ba[acodec^=mp4a]/ba)/b[height<=360][vcodec^=avc1]/b[height<=360]',
    }
  }
  return {
    label: '480p',
    estKbps: 1400,
    format: '(bv*[height<=480][vcodec^=avc1])+(ba[ext=m4a][abr<=140]/ba[ext=m4a]/ba[acodec^=mp4a]/ba)/b[height<=480][vcodec^=avc1]/b[height<=480]',
  }
}

async function probeVideoFile(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height:stream_side_data=rotation:format=duration',
      '-of', 'json', filePath,
    ], { timeout: 12000 })
    const parsed = JSON.parse(stdout)
    const vStream = (parsed?.streams || []).find(s => s.codec_type === 'video')
    const aStream = (parsed?.streams || []).find(s => s.codec_type === 'audio')
    let width = Number(vStream?.width) || null
    let height = Number(vStream?.height) || null
    const rotation = Number(vStream?.side_data_list?.find(d => d.rotation != null)?.rotation || 0)
    if (width && height && (Math.abs(rotation) === 90 || Math.abs(rotation) === 270)) {
      ;[width, height] = [height, width]
    }
    const dur = Number(parsed?.format?.duration)
    return {
      vcodec: vStream?.codec_name || null,
      pixFmt: vStream?.pix_fmt || null,
      acodec: aStream?.codec_name || null,
      width,
      height,
      durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
    }
  } catch {
    return { vcodec: null, pixFmt: null, acodec: null, width: null, height: null, durationSec: null }
  }
}

// Garantiza que el MP4 tenga video H.264 (yuv420p) y audio AAC con +faststart:
// si ya viene en H.264+AAC (el caso habitual), no recodifica nada; si el audio
// vino en Opus o el video en VP9/AV1, normaliza solo la pista necesaria.
async function ensureWhatsAppMp4(filePath, tmpDir, signal) {
  const info = await probeVideoFile(filePath)
  const videoOk = info.vcodec === 'h264' && (!info.pixFmt || info.pixFmt === 'yuv420p' || info.pixFmt === 'yuvj420p')
  const audioOk = !info.acodec || info.acodec === 'aac'
  if (videoOk && audioOk) {
    const st = await fs.stat(filePath)
    return { filePath, size: st.size, ...info }
  }

  const normalizedPath = path.join(tmpDir, 'normalized-wa.mp4')
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?',
  ]
  if (videoOk) {
    args.push('-c:v', 'copy')
  } else {
    args.push(
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
      '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    )
  }
  if (audioOk) {
    args.push('-c:a', 'copy')
  } else {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  }
  args.push('-movflags', '+faststart', normalizedPath)

  await execFileAsync(FFMPEG_BIN, args, { timeout: 240000, maxBuffer: 10 * 1024 * 1024, signal })
  const st = await fs.stat(normalizedPath)
  if (!st.size) throw new Error('FFmpeg dejó el video vacío al normalizar.')
  const updated = await probeVideoFile(normalizedPath)
  return { filePath: normalizedPath, size: st.size, ...updated }
}

async function downloadWithYtDlp(ytdlp, url, attemptDir, format, extraArgs = [], signal) {
  const outTemplate = path.join(attemptDir, 'video.%(ext)s')
  const cookies = await cookieArgs()
  await execFileAsync(ytdlp, [
    '-f', format,
    '--merge-output-format', 'mp4',
    '--ppa', 'Merger+ffmpeg_o:-movflags +faststart',
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
  ], { timeout: 240000, maxBuffer: 10 * 1024 * 1024, signal })

  const entries = await fs.readdir(attemptDir)
  // Ignora temporales (.part, .ytdl) y pistas sin unir (.f135.mp4).
  const validFiles = entries.filter(f =>
    f.startsWith('video.') &&
    !/\.(part|ytdl|temp)$/i.test(f) &&
    !/\.f\d+\./i.test(f),
  )
  const file = validFiles.find(f => f.toLowerCase().endsWith('.mp4')) || validFiles[0]
  if (!file) throw new Error('yt-dlp terminó sin dejar el video.')
  const filePath = path.join(attemptDir, file)
  const stat = await fs.stat(filePath)
  if (stat.size < 1024) throw new Error('yt-dlp dejó un archivo de video incompleto.')
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`El video pesa ${(stat.size / 1024 / 1024).toFixed(1)} MB, más del límite de 100 MB.`)
  }
  return { filePath, size: stat.size }
}

async function getVideo(url, { tier, signal }) {
  const errors = []
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-play2-'))
  try {
    const ytdlp = await ensureYtDlp()
    const fallbackFormat = '(bv*[height<=360][vcodec^=avc1]/bv*[height<=480])+(ba[ext=m4a]/ba[acodec^=mp4a]/ba)/b[height<=480]/b'
    const attempts = [
      ['web', tier.format, []],
      ['android_vr', tier.format, ['--extractor-args', 'youtube:player_client=android_vr']],
      ['mweb', tier.format, ['--extractor-args', 'youtube:player_client=mweb']],
      ['tv_embedded', tier.format, ['--extractor-args', 'youtube:player_client=tv_embedded']],
      ['fallback-360p', fallbackFormat, []],
    ]

    let rawVideo = null
    for (let i = 0; i < attempts.length && !rawVideo; i++) {
      if (signal?.aborted) throw new Error('Descarga cancelada por límite de tiempo.')
      const [clientName, format, extra] = attempts[i]
      const attemptDir = path.join(tmpDir, `attempt-${i}`)
      await fs.mkdir(attemptDir, { recursive: true })
      try {
        rawVideo = await downloadWithYtDlp(ytdlp, url, attemptDir, format, extra, signal)
        await logPlay(`yt-dlp ${clientName} OK:`, path.basename(rawVideo.filePath), `${(rawVideo.size / 1024 / 1024).toFixed(2)} MB`)
      } catch (error) {
        errors.push(`${clientName}: ${error.message}`)
        await logPlay(`yt-dlp ${clientName} falló:`, String(error.message).slice(0, 200))
        await fs.rm(attemptDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    if (!rawVideo) {
      throw new Error('No pude descargar el video desde YouTube en este momento.')
    }

    const ready = await ensureWhatsAppMp4(rawVideo.filePath, tmpDir, signal)
    if (ready.size > MAX_FILE_SIZE) {
      throw new Error(`El video pesa ${(ready.size / 1024 / 1024).toFixed(1)} MB, más del límite de 100 MB.`)
    }
    return { ...ready, tmpDir }
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function sanitizeFileName(name = 'video') {
  return String(name)
    .replace(/\.(mp4|mkv|webm|mov|avi)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video'
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
    const quotedUrl = !args?.[0] ? extractYTUrlFromText(msg.quoted?.text || msg.quoted?.body || '') : null
    const input = (args?.join(' ').trim() || quotedUrl || '').trim()
    if (!input) {
      return msg.reply(`*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗩𝗜𝗗𝗘𝗢*\n> ✐ ᴜsᴏ » *${usedPrefix}play2 <nombre o enlace>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}play2 despacito_`)
    }

    await logPlay('play2 inicio:', input.slice(0, 100))
    await msg.react?.('⏳').catch(() => {})

    const abortController = new AbortController()
    let tmpDir = null
    try {
      const meta = await getVideoMeta(input)
      if (meta.isLive) {
        await msg.react?.('❌').catch(() => {})
        return msg.reply('*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗩𝗜𝗗𝗘𝗢*\n> ✖ ᴇʀʀᴏʀ » *No se pueden descargar transmisiones en vivo activas.*')
      }

      const url = meta.url
      const videoId = meta.videoId || getVideoId(url)
      const title = meta.title || 'video'
      const fileName = `${sanitizeFileName(title)}.mp4`
      const metaDurationSec = meta.durationSec ?? parseDurationSeconds(meta.duration)
      const tier = selectQualityTier(metaDurationSec)

      // La portada de YouTube solo se usa en la tarjeta de info; el video usa un fotograma propio.
      const thumbBundlePromise = meta.title ? prepareThumbBundle(videoId, meta.thumbnail) : Promise.resolve(null)
      const videoPromise = withTimeout(
        getVideo(url, { tier, signal: abortController.signal }),
        300000,
        'La descarga del video tardó demasiado (5 min). Prueba con otro video o más tarde.',
        () => abortController.abort(),
      )

      let cardPromise = Promise.resolve()
      if (meta.title) {
        const statsPromise = meta.stats
          ? Promise.resolve(meta.stats)
          : getVideoStats(url).catch(() => ({ views: null, timestamp: null }))

        cardPromise = (async () => {
          try {
            const [thumbBundle, stats] = await Promise.all([
              thumbBundlePromise,
              withTimeout(statsPromise, 10000, 'stats').catch(() => ({ views: null, timestamp: null })),
            ])
            const views = stats.views ?? meta.views
            const lanzamiento = stats.timestamp ? relativeTimeEs(stats.timestamp) : agoToEs(meta.ago)
            const sizeMB = metaDurationSec ? (tier.estKbps * metaDurationSec / 8 / 1024).toFixed(2) : null
            const durationText = meta.duration || (metaDurationSec ? formatDuration(metaDurationSec) : 'Desconocida')
            const infoMessage = `*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗩𝗜𝗗𝗘𝗢*\n> ❀ ᴛíᴛᴜʟᴏ » *${title}*\n> ✐ ᴄᴀɴᴀʟ » *${meta.channel || 'Desconocido'}*\n> ⴵ ᴅᴜʀᴀᴄɪóɴ » *${durationText}* │ ✧ *${views != null ? formatViewsCompact(views) : 'Desconocido'}* vistas\n> ✰ ʀᴇsᴏʟᴜᴄɪóɴ » *${tier.label}* │ ❒ *${sizeMB ? `~${sizeMB} MB` : 'Desconocido'}*\n> ⊞ ʟᴀɴᴢᴀᴍɪᴇɴᴛᴏ » *${lanzamiento || 'Desconocido'}*\n> 🜸 ʟɪɴᴋ » _${url}_`

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
            } else if (meta.thumbnail) {
              await withTimeout(sock.sendMessage(msg.chat, { image: { url: meta.thumbnail }, caption: infoMessage }, sendOpts), 20000, 'La tarjeta de info no se pudo enviar.')
            } else {
              await msg.reply(infoMessage)
            }
          } catch (error) {
            console.error('[play2] no pude mandar la tarjeta:', error?.message || error)
          }
        })()
      }

      const video = await videoPromise
      tmpDir = video.tmpDir

      await Promise.race([cardPromise, new Promise(resolve => setTimeout(resolve, 2500))])

      const finalSeconds = video.durationSec || metaDurationSec || null
      const waThumb = await buildVideoWaThumbnail(video.filePath, tmpDir, {
        width: video.width,
        height: video.height,
        durationSec: finalSeconds,
      })

      // En documento se usa el JPG de la portada (thumbnail de YouTube); en video, el fotograma del MP4.
      const thumbBundle = await thumbBundlePromise.catch(() => null)
      const docThumb = thumbBundle?.microBuffer
        ? { buffer: thumbBundle.microBuffer, ...fitMaxEdge(thumbBundle.width, thumbBundle.height, WA_MICRO_THUMB_MAX_EDGE) }
        : waThumb

      const sizeText = formatBytes(video.size)
      const sendAsDocument = video.size > MAX_VIDEO_SIZE
      await logPlay(
        'video listo, enviando:',
        fileName,
        sizeText,
        `${video.width || '?'}x${video.height || '?'}`,
        waThumb ? `thumb=${waThumb.width}x${waThumb.height}(${waThumb.buffer.length}B)` : 'sin-thumb',
        sendAsDocument ? '(documento)' : '(video)',
      )

      const sendOptions = {
        quoted: msg,
        ephemeralExpiration: msg.expiration,
        mediaUploadTimeoutMs: 180000,
      }

      if (sendAsDocument) {
        await sock.sendMessage(msg.chat, {
          document: { url: video.filePath },
          mimetype: 'video/mp4',
          fileName,
          ...(docThumb ? {
            jpegThumbnail: docThumb.buffer,
            thumbnailWidth: docThumb.width,
            thumbnailHeight: docThumb.height,
          } : {}),
        }, { ...sendOptions, mediaUploadTimeoutMs: 240000 })
        await logPlay('video enviado OK:', fileName, '(documento, +50 MB)')
      } else {
        let sentAsVideo = false
        let lastError = null
        for (let attempt = 0; attempt < 2 && !sentAsVideo; attempt++) {
          try {
            await sock.sendMessage(msg.chat, {
              video: { url: video.filePath },
              mimetype: 'video/mp4',
              fileName,
              ...(video.width && video.height ? { width: video.width, height: video.height } : {}),
              ...(finalSeconds ? { seconds: finalSeconds } : {}),
              ...(waThumb ? { jpegThumbnail: waThumb.buffer } : {}),
            }, sendOptions)
            sentAsVideo = true
          } catch (error) {
            lastError = error
            await logPlay(`envío como video falló (intento ${attempt + 1}):`, String(error?.message || error).slice(0, 300))
          }
        }
        if (!sentAsVideo) {
          await logPlay('mando como documento tras fallar 2 veces:', String(lastError?.message || '').slice(0, 200))
          await sock.sendMessage(msg.chat, {
            document: { url: video.filePath },
            mimetype: 'video/mp4',
            fileName,
            ...(docThumb ? {
              jpegThumbnail: docThumb.buffer,
              thumbnailWidth: docThumb.width,
              thumbnailHeight: docThumb.height,
            } : {}),
          }, { ...sendOptions, mediaUploadTimeoutMs: 240000 })
        }
        await logPlay('video enviado OK:', fileName, sentAsVideo ? '(video)' : '(documento)')
      }

      await msg.react?.('✅').catch(() => {})
    } catch (error) {
      abortController.abort()
      console.error('[play2] error:', error?.stack || error)
      await msg.react?.('❌').catch(() => {})
      await msg.reply(`*「✦」 𝗗𝗘𝗦𝗖𝗔𝗥𝗚𝗔𝗡𝗗𝗢 𝗩𝗜𝗗𝗘𝗢*\n> ✖ ᴇʀʀᴏʀ » *${error?.message || 'No pude descargar el video. Inténtalo más tarde.'}*`)
    } finally {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  },
}
