// ytmp3.js — Descargar el audio (MP3) de un video de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Búsqueda con yt-search y descarga con la API pública
// Delirius (sin key). Requiere la dependencia nueva: yt-search.
// ADVERTENCIA: al probar el 2026-11-25, el endpoint de Delirius devolvía
// error del servidor ("TypeError ... Received null"). Si el comando falla,
// es la API, no el comando: reintenta más tarde.

import yts from 'yt-search'

const DELIRIUS_URL = 'https://api.delirius.online'

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

// La respuesta de Delirius varía; se aceptan varias formas de la URL.
function extractDownload(json) {
  const d = json?.data || json?.result || json
  const url = d?.download?.url || d?.url || d?.dl || d?.download || null
  if (!url || typeof url !== 'string') return null
  return { url, name: d?.download?.filename || d?.filename || d?.title || 'audio.mp3' }
}

async function getAudioFromApi(url) {
  const res = await fetch(`${DELIRIUS_URL}/download/ytmp3?url=${encodeURIComponent(url)}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`La API de descarga respondió HTTP ${res.status}.`)
  const json = await res.json()
  if (json?.status === false) throw new Error(json?.msg || 'La API no devolvió el audio.')
  const dl = extractDownload(json)
  if (!dl?.url) throw new Error('La API no devolvió el enlace de descarga.')
  const audioRes = await fetch(dl.url)
  if (!audioRes.ok) throw new Error(`No se pudo bajar el audio: HTTP ${audioRes.status}.`)
  const buffer = Buffer.from(await audioRes.arrayBuffer())
  if (!buffer.length) throw new Error('El audio descargado llegó vacío.')
  return { buffer, name: dl.name.endsWith('.mp3') ? dl.name : `${dl.name}.mp3` }
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
      const audio = await getAudioFromApi(url)
      await sock.sendMessage(msg.chat, {
        audio: audio.buffer,
        fileName: audio.name,
        mimetype: 'audio/mpeg',
      }, { quoted: msg })
    } catch (error) {
      console.error('[play] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar el audio. Inténtalo más tarde.')
    }
  },
}
