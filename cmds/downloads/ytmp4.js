// ytmp4.js — Descargar el video (MP4) de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Búsqueda con yt-search y descarga con la API pública
// Delirius (sin key). Requiere la dependencia nueva: yt-search.
// ADVERTENCIA: al probar el 2026-11-25, el endpoint de Delirius devolvía
// HTTP 410. Si el comando falla, es la API, no el comando: reintenta más
// tarde. Videos de más de 50 MB se mandan como documento.

import yts from 'yt-search'

const DELIRIUS_URL = 'https://api.delirius.online'
const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50 MB

const isYTUrl = url =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i.test(url || '')

function getVideoId(text = '') {
  const raw = String(text || '').trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw
  return raw.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/)|[?&]v=)([a-zA-Z0-9_-]{11})/,
  )?.[1] || null
}

async function getYoutubeUrl(input) {
  const id = getVideoId(input)
  if (id) return `https://youtu.be/${id}`
  if (isYTUrl(input)) return input
  const search = await yts(input)
  const video = search.videos?.[0] || search.all?.find(v => v.type === 'video')
  if (!video?.url) throw new Error('No encontré un video válido de YouTube para eso.')
  return video.url
}

// La respuesta de Delirius varía; se aceptan varias formas de los datos.
function extractVideo(json) {
  const d = json?.data || json?.result || json
  const dl = d?.download || {}
  const url = dl.url || d?.url || d?.dl || null
  if (!url || typeof url !== 'string') return null
  return {
    url,
    title: d?.title || 'video',
    channel: d?.author?.name || d?.channel || d?.author || 'Desconocido',
    duration: d?.duration || d?.timestamp || 'Desconocida',
    views: d?.views || 0,
    quality: dl.quality || d?.quality || '360p',
    size: dl.size || d?.size || null,
    thumbnail: d?.thumbnail || d?.image || null,
  }
}

async function getDeliriusVideo(url) {
  const res = await fetch(`${DELIRIUS_URL}/download/ytmp4?url=${encodeURIComponent(url)}`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`La API de descarga respondió HTTP ${res.status}.`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('La API devolvió una respuesta inválida.')
  }
  if (data?.status === false) throw new Error(data?.msg || 'La API no devolvió el video.')
  const video = extractVideo(data)
  if (!video?.url) throw new Error('La API no devolvió la URL de descarga.')
  return video
}

async function getRemoteFileSize(url) {
  const head = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } }).catch(() => null)
  let bytes = Number(head?.headers?.get('content-length'))
  if (Number.isFinite(bytes) && bytes > 0) return bytes
  const range = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-0', 'user-agent': 'Mozilla/5.0' } }).catch(() => null)
  const match = range?.headers?.get('content-range')?.match(/\/(\d+)$/)
  if (match?.[1]) {
    bytes = Number(match[1])
    if (Number.isFinite(bytes) && bytes > 0) return bytes
  }
  bytes = Number(range?.headers?.get('content-length'))
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

async function getThumbnail(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
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

function parseFileSize(size) {
  if (!size) return null
  const raw = String(size).trim()
  const match = raw.match(/([\d.,]+)\s*(bytes?|b|kb|kib|mb|mib|gb|gib)/i)
  if (!match) return null
  let valueText = match[1]
  if (valueText.includes(',') && valueText.includes('.')) valueText = valueText.replace(/,/g, '')
  else valueText = valueText.replace(',', '.')
  const value = Number(valueText)
  if (!Number.isFinite(value) || value <= 0) return null
  const mult = { b: 1, byte: 1, bytes: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 }
  return Math.round(value * (mult[match[2].toLowerCase()] || 1))
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
    try {
      const url = await getYoutubeUrl(input)
      const data = await getDeliriusVideo(url)
      const title = data.title || 'video'
      const fileName = `${sanitizeFileName(title)}.mp4`
      const sizeBytes = parseFileSize(data.size) || await getRemoteFileSize(data.url).catch(() => null)
      const sizeText = sizeBytes ? formatBytes(sizeBytes) : data.size || 'Desconocido'
      const sendAsDocument = sizeBytes ? sizeBytes > MAX_VIDEO_SIZE : false
      const infoMessage = `*Descargando video:* ${title}\n\n*Canal:* ${data.channel}\n*Duración:* ${data.duration}\n*Vistas:* ${Number(data.views || 0).toLocaleString('es-PE')}\n*Calidad:* ${data.quality}\n*Tamaño:* ${sizeText}\n*Enlace:* ${url}`
      if (data.thumbnail) {
        await sock.sendMessage(msg.chat, { image: { url: data.thumbnail }, caption: infoMessage }, { quoted: msg })
      } else {
        await msg.reply(infoMessage)
      }
      const caption = `*Video descargado*\n\n*Calidad:* ${data.quality}\n*Tamaño:* ${sizeText}`
      if (sendAsDocument) {
        await sock.sendMessage(msg.chat, { document: { url: data.url }, mimetype: 'video/mp4', fileName, caption }, { quoted: msg })
        return
      }
      try {
        await sock.sendMessage(msg.chat, {
          video: { url: data.url },
          mimetype: 'video/mp4',
          fileName,
          caption,
          ...(data.thumbnail ? { jpegThumbnail: await getThumbnail(data.thumbnail).catch(() => null) } : {}),
        }, { quoted: msg })
      } catch {
        await sock.sendMessage(msg.chat, { document: { url: data.url }, mimetype: 'video/mp4', fileName, caption }, { quoted: msg })
      }
    } catch (error) {
      console.error('[play2] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar el video. Inténtalo más tarde.')
    }
  },
}
