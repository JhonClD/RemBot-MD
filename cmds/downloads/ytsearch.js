// ytsearch.js — Buscar videos de YouTube.
// Autor: Jhon 𝗖𝗜𝗗. Busca con yt-search.

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

// Vistas en corto: 2100000 → "2.1M", 1500 → "1.5K".
function formatViewsCompact(views) {
  const n = Number(views || 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function formatVideo(v) {
  return `❀ *${v.title}*\n> ⴵ ᴅᴜʀᴀᴄɪóɴ » *${v.timestamp || 'Desconocida'}* │ ✧ *${v.views ? formatViewsCompact(v.views) : 'Desconocidas'}* vistas\n> ⊞ sᴜʙɪᴅᴏ » *${v.ago || 'Desconocido'}*\n> 🜸 ʟɪɴᴋ » _${v.url}_`
}

function formatChannel(v) {
  return `✐ *${v.name}*\n> ♥ sᴜsᴄʀɪᴘᴛᴏʀᴇs » *${v.subCountLabel || v.subCount || 'Desconocidos'}*\n> ❀ ᴠɪᴅᴇᴏs » *${v.videoCount || 'Desconocidos'}*\n> 🜸 ʟɪɴᴋ » _${v.url}_`
}

export default {
  command: ['ytsearch', 'yts', 'search'],
  category: 'downloads',
  description: 'Busca videos de YouTube. Uso: `ytsearch <título del video>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args?.[0]) {
      return msg.reply(`*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘*\n> ✐ ᴜsᴏ » *${usedPrefix}ytsearch <búsqueda>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}ytsearch despacito_`)
    }
    const query = args.join(' ').trim()
    try {
      const result = await yts(query)
      const results = (result?.all || []).filter(v => v?.type === 'video' || v?.type === 'channel')
      if (!results.length) {
        return msg.reply(`*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘*\n> ✖ ᴇʀʀᴏʀ » *No encontré resultados para ${query}.*`)
      }
      const text = results.slice(0, 10).map(v => (v.type === 'video' ? formatVideo(v) : formatChannel(v))).join('\n\n──────────\n\n')
      const firstVideo = results.find(v => v.type === 'video')
      const thumbUrl = firstVideo?.image || firstVideo?.thumbnail || null
      const thumb = thumbUrl ? await fetchBuffer(thumbUrl) : null
      if (thumb) {
        await sock.sendMessage(msg.chat, { image: thumb, caption: text }, { quoted: msg })
      } else {
        await msg.reply(text)
      }
    } catch (error) {
      console.error('[ytsearch] error:', error?.stack || error)
      await msg.reply('*「✦」 𝗬𝗢𝗨𝗧𝗨𝗕𝗘*\n> ✖ ᴇʀʀᴏʀ » *No pude buscar en YouTube ahora. Inténtalo más tarde.*')
    }
  },
}
