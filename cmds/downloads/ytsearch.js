// ytsearch.js — Buscar videos de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Requiere la dependencia nueva: yt-search.

import yts from 'yt-search'

async function fetchBuffer(url, timeout = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length ? buffer : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function formatVideo(v) {
  return `*Título:* ${v.title}\n\n*Duración:* ${v.timestamp || 'Desconocida'}\n*Subido:* ${v.ago || 'Desconocido'}\n*Vistas:* ${v.views || 'Desconocidas'}\n*Url:* ${v.url}`
}

function formatChannel(v) {
  return `*Canal:* ${v.name}\n*Url:* ${v.url}\n*Suscriptores:* ${v.subCountLabel || v.subCount || 'Desconocidos'}${v.subCount ? ` (${v.subCount})` : ''}\n*Videos totales:* ${v.videoCount || 'Desconocidos'}`
}

export default {
  command: ['ytsearch', 'yts', 'search'],
  category: 'downloads',
  description: 'Busca videos de YouTube. Uso: `ytsearch <título del video>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args?.[0]) {
      return msg.reply(`Escribe qué video quieres buscar.\nEjemplo: *${usedPrefix}ytsearch despacito*`)
    }
    const query = args.join(' ').trim()
    try {
      const result = await yts(query)
      const items = (result?.all || []).filter(v => v?.type === 'video' || v?.type === 'channel')
      if (!items.length) {
        return msg.reply(`No encontré resultados para *${query}*.`)
      }
      const text = items.slice(0, 10).map(v => (v.type === 'video' ? formatVideo(v) : formatChannel(v))).join('\n\n──────────\n\n')
      const firstVideo = items.find(v => v.type === 'video')
      const thumbUrl = firstVideo?.image || firstVideo?.thumbnail || null
      const thumb = thumbUrl ? await fetchBuffer(thumbUrl) : null
      if (thumb) {
        await sock.sendMessage(msg.chat, { image: thumb, caption: text }, { quoted: msg })
      } else {
        await msg.reply(text)
      }
    } catch (error) {
      console.error('[ytsearch] error:', error?.stack || error)
      await msg.reply('No pude buscar en YouTube ahora. Inténtalo más tarde.')
    }
  },
}
