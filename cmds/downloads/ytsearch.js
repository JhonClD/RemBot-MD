// ytsearch.js — Buscar videos y canales de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Busca con yt-search (con respaldo automático a yt-dlp
// si YouTube bloquea el scraping) y genera miniatura HD 16:9 + jpegThumbnail
// optimizado para WhatsApp.

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

const WA_MICRO_THUMB_MAX_EDGE = 96
const WA_MICRO_THUMB_MAX_BYTES = 8 * 1024

const ytdlpState = globalThis.__rembotYtDlpState ??= { verifiedPath: null, initPromise: null }

function withTimeout(promise, ms, errorMessage) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMessage || `Tiempo agotado (${Math.round(ms / 1000)}s).`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function cookieArgs() {
  for (const candidate of COOKIE_CANDIDATES) {
    try {
      const st = await fs.stat(candidate)
      if (st.isFile() && st.size > 0) return ['--cookies', candidate]
    } catch {}
  }
  return []
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

function fitMaxEdge(width, height, maxEdge = WA_MICRO_THUMB_MAX_EDGE) {
  const w = Math.max(1, Number(width) || 16)
  const h = Math.max(1, Number(height) || 9)
  const scale = maxEdge / Math.max(w, h)
  return {
    width: Math.max(16, Math.round(w * scale)),
    height: Math.max(16, Math.round(h * scale)),
  }
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

async function prepareThumbBundle(videoId, rawThumb) {
  const rawBuffer = await fetchRawThumbnail(buildThumbCandidates(videoId, rawThumb))
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

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembot-yts-'))
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
    let width = 1280
    let height = 720
    try {
      const { stdout } = await execFileAsync(FFPROBE_BIN, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', cardPath,
      ], { timeout: 8000 })
      const s = JSON.parse(stdout)?.streams?.[0]
      if (s?.width && s?.height) { width = Number(s.width); height = Number(s.height) }
    } catch {}
    const microDims = fitMaxEdge(width, height, WA_MICRO_THUMB_MAX_EDGE)
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
      width,
      height,
      microBuffer: microBuffer?.length && microBuffer.length <= WA_MICRO_THUMB_MAX_BYTES ? microBuffer : null,
    }
  } catch {
    return null
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function formatViewsCompact(views) {
  const n = Number(views || 0)
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
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

const ROMAN_MAP = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12' }

const BASE_STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'y', 'o', 'u', 'a', 'e',
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'and', 'or', 'from',
  'feat', 'ft', 'prod', 'x', 'vs',
  'oficial', 'official', 'video', 'audio', 'music', 'musica', 'cancion', 'song', 'hd', '4k', 'hq', '1080p', '720p', 'mv',
])

function cleanSearchQuery(raw = '') {
  let q = String(raw || '').replace(/\s+/g, ' ').trim()
  const strippedLead = q.replace(/^(?:pon(?:me)?|busca(?:r)?|descarga(?:r)?|baja(?:r)?|reproduce|quiero\s+(?:escuchar|ver|descargar))\s+/i, '').trim()
  if (strippedLead.length >= 2) q = strippedLead
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

function parseDurationSeconds(timestamp) {
  const parts = String(timestamp || '').trim().split(':').map(Number)
  if (!parts.length || !timestamp || parts.some(Number.isNaN)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
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
    op: /\bop\s*\d*\b|opening|オープニング/i.test(q),
    ed: /\bed\s*\d*\b|ending|エンディング/i.test(q),
    full: /\bfull\b|フル|complet[oa]|extended/i.test(q),
    albumOrLong: /\b(album|playlist|mix|compilacion|compilation|megamix|set|1\s*hora|1\s*hour|\d+\s*h(?:oras?|ours?)?|podcast|episodio|episode|capitulo|pelicula|movie|documental|gameplay|walkthrough|conferencia)\b|todos los/i.test(qn),
    tutorial: /\b(tutorial|curso|clase|como\s+hacer|como\s+tocar|how\s+to|guia|aprende|aprender|acordes|chords)\b/i.test(qn),
    reaction: /\b(reaccion|reaction|reacting\s+to|first\s+time|review|analisis|critica|opinion)\b/i.test(qn),
  }
}

function scoreSearchVideo(c, idx, query, allVideos) {
  const intent = analyzeQueryIntent(query)
  const tRaw = String(c.title || '')
  const chRaw = String(c.author?.name || c.author || '')
  const descRaw = String(c.description || '')
  const tNorm = normalizeMatchText(tRaw)
  const chNorm = normalizeMatchText(chRaw)
  const descNorm = normalizeMatchText(descRaw)
  const combined = `${tNorm} ${chNorm}`
  const fullHay = `${combined} ${descNorm}`
  const dur = c.durationSec

  let score = Math.max(0, 32 - idx * 2.0)

  const dynamicStops = new Set(BASE_STOP_WORDS)
  if (intent.full) ['full', 'completo', 'completa', 'extended'].forEach(w => dynamicStops.add(w))
  if (intent.op || intent.ed) ['op', 'ed', 'opening', 'ending'].forEach(w => dynamicStops.add(w))

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
    score += (hitScore / tokens.length) * 55

    const nonChannelTokens = tokens.filter(tok => !matchesToken(chWords, chNorm, tok))
    if (nonChannelTokens.length && nonChannelTokens.length < tokens.length) {
      const titleMatched = nonChannelTokens.filter(tok => matchesToken(titleWords, tNorm, tok) || matchesToken(fullHayWords, descNorm, tok))
      if (titleMatched.length === 0) {
        const someoneMatchesTitle = allVideos.some(other => {
          const ot = normalizeMatchText(other.title || '')
          const ow = new Set(ot.split(' '))
          return nonChannelTokens.some(tok => matchesToken(ow, ot, tok))
        })
        if (someoneMatchesTitle) score -= 110
      } else {
        score += (titleMatched.length / nonChannelTokens.length) * 22
      }
    }
  }

  const isVevo = /vevo$/i.test(chRaw.replace(/\s+/g, ''))
  const matchesTitleArtist = channelMatchesArtistInTitle(tRaw, chRaw)
  const isKnownPublisher = /\b(official|oficial|records|music|entertainment|animation|aniplex|toho|crunchyroll|rockstar\s*games|playstation|nintendo|xbox|netflix|marvel|warner|sony|universal|hybe|smtown|jyp|yg|bighit)\b/i.test(chRaw)

  if (c.isArtist || isVevo) score += 48
  else if (matchesTitleArtist) score += 36
  else if (c.isVerified) score += 22
  else if (isKnownPublisher) score += 18

  if (!c.isArtist && !c.isVerified && /\b(jr|fan|fans|fanpage|clips|reupload)\b/i.test(chNorm)) {
    score -= 28
  }

  if (c.views != null && c.views > 0) {
    score += Math.min(38, Math.log10(c.views + 1) * 4.2)
  }

  if (!intent.cover && /\b(cover|guitar\s+rendition|tributo|tribute|parodia|parody)\b/i.test(tNorm)) score -= 40
  if (!intent.remix && /\b(remix|rmx|mashup|bootleg|afro\s+house|guaracha)\b/i.test(tNorm)) score -= 35
  if (!intent.editMod && /\b(sped\s*up|slowed|reverb|nightcore|8d\s+audio|bass\s*boost(?:ed)?)\b/i.test(tNorm)) score -= 50
  if (!intent.karaoke && /\b(karaoke|instrumental|pista|off\s*vocal|sin\s*voz)\b/i.test(tNorm)) score -= 55
  if (!intent.reaction && /\b(reaccion|reaction|reacting\s+to|first\s+time\s+(?:hearing|watching))\b/i.test(tNorm)) score -= 55
  if (!intent.tutorial && /\b(como\s+tocar|how\s+to\s+play|chords|acordes)\b/i.test(tNorm)) score -= 45

  const hasOpTag = /オープニング|opening|\bop\s*\d*\b/i.test(tRaw)
  const hasEdTag = /エンディング|ending|\bed\s*\d*\b/i.test(tRaw)
  if (intent.op && !intent.ed && !intent.full) {
    if (hasOpTag) score += 45
    if (hasEdTag && !hasOpTag) score -= 70
    if (dur != null && dur >= 50 && dur <= 145) score += 60
  } else if (intent.ed && !intent.op && !intent.full) {
    if (hasEdTag) score += 45
    if (hasOpTag && !hasEdTag) score -= 70
    if (dur != null && dur >= 50 && dur <= 145) score += 60
  } else if (intent.full && dur != null && dur >= 170 && dur <= 540) {
    score += 55
  }

  return score
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
    if (!res.ok) return { videos: [], channels: [] }
    const data = await res.json()
    const videos = []
    const channels = []
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
        videos.push({
          type: 'video',
          videoId: vr.videoId,
          url: `https://youtu.be/${vr.videoId}`,
          title,
          author: { name: channel },
          description,
          timestamp: timestamp || (isLive ? 'EN VIVO' : null),
          durationSec: parseDurationSeconds(timestamp),
          views: parseViewsAny(viewsRaw),
          ago,
          thumbnail: thumb,
          image: thumb,
          isArtist,
          isVerified,
          isLive,
        })
        return
      }
      if (node.channelRenderer?.channelId) {
        const cr = node.channelRenderer
        const name = cr.title?.simpleText || cr.title?.runs?.map(r => r.text).join('') || ''
        const badges = (cr.ownerBadges || []).map(b => b.metadataBadgeRenderer?.style || '')
        const isArtist = badges.some(s => s.includes('ARTIST'))
        const isVerified = isArtist || badges.some(s => s.includes('VERIFIED'))
        const subText = cr.videoCountText?.simpleText || cr.subscriberCountText?.simpleText || ''
        const handle = cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || `/channel/${cr.channelId}`
        channels.push({
          type: 'channel',
          channelId: cr.channelId,
          name,
          subCountLabel: subText || null,
          videoCount: null,
          url: `https://www.youtube.com${handle}`,
          isArtist,
          isVerified,
        })
        return
      }
      for (const v of Object.values(node)) walk(v)
    }
    walk(data)
    return { videos, channels }
  } catch {
    return { videos: [], channels: [] }
  }
}

async function searchWithYtDlp(query) {
  try {
    const ytdlp = await ensureYtDlp()
    const cookies = await cookieArgs()
    const { stdout } = await execFileAsync(ytdlp, [
      '--flat-playlist', '--dump-json', '--no-warnings',
      '--socket-timeout', '15',
      '--js-runtimes', 'node',
      ...cookies,
      `ytsearch12:${query}`,
    ], { timeout: 25000, maxBuffer: 5 * 1024 * 1024 })
    const items = []
    for (const line of String(stdout).trim().split('\n')) {
      if (!line.trim().startsWith('{')) continue
      try {
        const d = JSON.parse(line)
        if (!d?.id) continue
        const durationSec = Number(d.duration)
        const views = Number(d.view_count)
        const ts = Number(d.timestamp || d.release_timestamp)
        const thumb = Array.isArray(d.thumbnails) && d.thumbnails.length
          ? d.thumbnails[d.thumbnails.length - 1]?.url
          : (d.thumbnail || null)
        items.push({
          type: 'video',
          videoId: d.id,
          title: d.title || 'Sin título',
          author: { name: d.uploader || d.channel || null },
          description: d.description || '',
          timestamp: Number.isFinite(durationSec) && durationSec > 0 ? formatDuration(durationSec) : (d.live_status === 'is_live' ? 'EN VIVO' : null),
          durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
          views: Number.isFinite(views) && views > 0 ? views : null,
          ago: Number.isFinite(ts) && ts > 0 ? relativeTimeEs(ts) : null,
          url: `https://youtu.be/${d.id}`,
          thumbnail: thumb,
          image: thumb,
          isArtist: Boolean(d.artist || d.track),
          isVerified: Boolean(d.channel_is_verified),
        })
      } catch {}
    }
    return items
  } catch {
    return []
  }
}

function formatVideo(v) {
  const channel = v.author?.name || v.author || null
  const badge = v.isArtist ? ' ♪' : (v.isVerified ? ' ✓' : '')
  const uploaded = agoToEs(v.ago) || 'Desconocido'
  return `❀ *${v.title}*${channel ? `\n> ✐ ᴄᴀɴᴀʟ » *${channel}${badge}*` : ''}\n> ⴵ ᴅᴜʀᴀᴄɪóɴ » *${v.timestamp || 'Desconocida'}* │ ✧ *${v.views != null ? formatViewsCompact(v.views) : 'Desconocidas'}* vistas\n> ⊞ sᴜʙɪᴅᴏ » *${uploaded}*\n> 🜸 ʟɪɴᴋ » _${v.url}_`
}

function formatChannel(v) {
  const badge = v.isArtist ? ' ♪' : (v.isVerified ? ' ✓' : '')
  return `✐ *${v.name}${badge}*\n> ♥ sᴜsᴄʀɪᴘᴛᴏʀᴇs » *${v.subCountLabel || v.subCount || 'Desconocidos'}*${v.videoCount ? `\n> ❀ ᴠɪᴅᴇᴏs » *${v.videoCount}*` : ''}\n> 🜸 ʟɪɴᴋ » _${v.url}_`
}

export default {
  command: ['ytsearch', 'yts', 'search'],
  category: 'downloads',
  description: 'Busca videos de YouTube. Uso: `ytsearch <título del video>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args?.[0]) {
      return msg.reply(`*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘*\n> ✐ ᴜsᴏ » *${usedPrefix}ytsearch <búsqueda>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}ytsearch despacito_`)
    }
    const rawQuery = args.join(' ').trim()
    const query = cleanSearchQuery(rawQuery)
    await msg.react?.('⏳').catch(() => {})
    try {
      const [itRes, ytsRes] = await Promise.allSettled([
        searchInnertube(query),
        withTimeout(yts(query), 10000, 'yt-search tardó demasiado.'),
      ])

      const videoById = new Map()
      const videoOrder = []
      const mergeVideo = (v) => {
        if (!v?.videoId) return
        const prev = videoById.get(v.videoId)
        if (!prev) {
          videoById.set(v.videoId, v)
          videoOrder.push(v.videoId)
        } else {
          videoById.set(v.videoId, {
            ...prev,
            title: prev.title || v.title,
            author: prev.author?.name ? prev.author : v.author,
            description: prev.description || v.description || '',
            timestamp: prev.timestamp || v.timestamp,
            durationSec: prev.durationSec ?? v.durationSec,
            views: prev.views ?? v.views,
            ago: prev.ago || v.ago,
            thumbnail: prev.thumbnail || v.thumbnail,
            image: prev.image || v.image,
            isArtist: Boolean(prev.isArtist || v.isArtist),
            isVerified: Boolean(prev.isVerified || v.isVerified),
            isLive: Boolean(prev.isLive || v.isLive),
          })
        }
      }

      const channelByKey = new Map()
      const mergeChannel = (c) => {
        const key = normalizeMatchText(c?.name || '')
        if (!key) return
        const prev = channelByKey.get(key)
        if (!prev) channelByKey.set(key, c)
        else {
          channelByKey.set(key, {
            ...prev,
            subCountLabel: prev.subCountLabel || c.subCountLabel || c.subCount || null,
            videoCount: prev.videoCount || c.videoCount || null,
            url: prev.url || c.url,
            isArtist: Boolean(prev.isArtist || c.isArtist),
            isVerified: Boolean(prev.isVerified || c.isVerified),
          })
        }
      }

      if (itRes.status === 'fulfilled') {
        for (const v of itRes.value.videos) mergeVideo(v)
        for (const c of itRes.value.channels) mergeChannel(c)
      }
      if (ytsRes.status === 'fulfilled' && ytsRes.value) {
        for (const item of (ytsRes.value.all || [])) {
          if (item?.type === 'video' && item.videoId) {
            mergeVideo({
              type: 'video',
              videoId: item.videoId,
              url: `https://youtu.be/${item.videoId}`,
              title: item.title,
              author: item.author,
              description: item.description || '',
              timestamp: item.timestamp,
              durationSec: parseDurationSeconds(item.timestamp),
              views: parseViewsAny(item.views),
              ago: item.ago,
              thumbnail: item.thumbnail || item.image,
              image: item.image || item.thumbnail,
              isArtist: false,
              isVerified: false,
              isLive: Boolean(item.live || item.isLive),
            })
          } else if (item?.type === 'channel' && item.name) {
            mergeChannel(item)
          }
        }
      }

      let videos = videoOrder.map(id => videoById.get(id))
      if (!videos.length) {
        videos = await searchWithYtDlp(query)
      }

      const rankedVideos = videos
        .map((v, i) => ({ v, s: scoreSearchVideo(v, i, query, videos) }))
        .sort((a, b) => b.s - a.s)
        .map(x => x.v)

      // Si el usuario buscó el nombre exacto de un canal, se incluye arriba junto a los mejores videos.
      const qNorm = normalizeMatchText(query)
      const matchedChannels = [...channelByKey.values()].filter(c => {
        const cn = normalizeMatchText(c.name)
        return cn && (cn === qNorm || (qNorm.length >= 4 && cn.includes(qNorm)))
      }).slice(0, 1)

      const results = [...rankedVideos.slice(0, 10 - matchedChannels.length), ...matchedChannels]
      if (!results.length) {
        await msg.react?.('❌').catch(() => {})
        return msg.reply(`*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘*\n> ✖ ᴇʀʀᴏʀ » *No encontré resultados para ${rawQuery}.*`)
      }

      // Si hay canal exacto, va tras el primer video oficial para mantener el mejor video en #1
      const orderedResults = matchedChannels.length
        ? (rankedVideos.length ? [rankedVideos[0], ...matchedChannels, ...rankedVideos.slice(1, 9)] : matchedChannels)
        : rankedVideos.slice(0, 10)

      const body = orderedResults
        .map(v => (v.type === 'video' ? formatVideo(v) : formatChannel(v)))
        .join('\n\n──────────\n\n')
      const text = `*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘 • 𝗕𝗨́𝗦𝗤𝗨𝗘𝗗𝗔*\n\n${body}`

      const firstVideo = orderedResults.find(v => v.type === 'video')
      const videoId = firstVideo?.videoId || null
      const thumbUrl = firstVideo?.image || firstVideo?.thumbnail || null
      const thumbBundle = (videoId || thumbUrl) ? await prepareThumbBundle(videoId, thumbUrl) : null

      const sendOpts = { quoted: msg, ephemeralExpiration: msg.expiration }
      if (thumbBundle?.cardBuffer) {
        await sock.sendMessage(msg.chat, {
          image: thumbBundle.cardBuffer,
          mimetype: 'image/jpeg',
          width: thumbBundle.width,
          height: thumbBundle.height,
          ...(thumbBundle.microBuffer ? { jpegThumbnail: thumbBundle.microBuffer } : {}),
          caption: text,
        }, sendOpts)
      } else {
        await msg.reply(text)
      }
      await msg.react?.('✅').catch(() => {})
    } catch (error) {
      console.error('[ytsearch] error:', error?.stack || error)
      await msg.react?.('❌').catch(() => {})
      await msg.reply('*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘*\n> ✖ ᴇʀʀᴏʀ » *No pude buscar en YouTube ahora. Inténtalo más tarde.*')
    }
  },
}
