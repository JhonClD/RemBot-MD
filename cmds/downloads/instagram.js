// instagram.js — Descargar un reel o post de Instagram.
// Autor: Jhon 𝗖𝗜𝗗. Solo APIs públicas sin key (Ootaizumi, Delirius, Zenzxz),
// probadas en orden hasta que una devuelva el medio.

const APIS = [
  {
    name: 'Ootaizumi',
    endpoint: url => `https://api.ootaizumi.web.id/downloader/instagram/v1?url=${encodeURIComponent(url)}`,
    extractor: res => {
      if (!res?.status || !res.result?.media?.length) return null
      const media = res.result.media[0]
      if (!media?.url) return null
      return {
        type: media.isVideo ? 'video' : 'image',
        title: res.result.metadata?.author || null,
        caption: null,
        like: res.result.metadata?.like === -1 ? null : res.result.metadata?.like,
        views: res.result.metadata?.views || null,
        duration: res.result.metadata?.duration ? `${Math.round(res.result.metadata.duration)}s` : null,
        format: media.isVideo ? 'mp4' : 'jpg',
        url: media.url,
        thumbnail: res.result.ppc || null,
      }
    },
  },
  {
    name: 'Delirius',
    endpoint: url => `https://api.delirius.online/download/instagram?url=${encodeURIComponent(url)}`,
    extractor: res => {
      if (!res?.status || !res.data?.length) return null
      const media = res.data[0]
      if (!media?.url) return null
      return {
        type: media.type || (media.url.includes('.mp4') ? 'video' : 'image'),
        title: null,
        caption: null,
        format: media.type === 'video' ? 'mp4' : 'jpg',
        url: media.url,
      }
    },
  },
  {
    name: 'Zenzxz',
    endpoint: url => `https://api.zenzxz.my.id/download/instagram?url=${encodeURIComponent(url)}`,
    extractor: res => {
      if (!res?.status || !res.result?.url) return null
      return {
        type: res.result.is_video ? 'video' : 'image',
        title: res.result.username || null,
        caption: res.result.caption || null,
        format: res.result.is_video ? 'mp4' : 'jpg',
        url: res.result.url,
        thumbnail: res.result.thumbnail || null,
      }
    },
  },
]

async function fetchJson(url, timeout = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function getInstagramMedia(url) {
  for (const api of APIS) {
    try {
      const result = api.extractor(await fetchJson(api.endpoint(url)))
      if (result) return result
    } catch (error) {
      console.error(`[instagram] ${api.name} falló:`, error?.message || error)
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

export default {
  command: ['instagram', 'ig', 'reel'],
  category: 'downloads',
  description: 'Descarga un reel o post de Instagram. Uso: `ig <enlace de Instagram>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args[0]) {
      return msg.reply(`Pega un enlace de Instagram.\nEjemplo: *${usedPrefix}ig https://www.instagram.com/reel/ABC123/*`)
    }
    if (!/instagram\.com\/(p|reel|share|tv|stories)\//.test(args[0])) {
      return msg.reply('Ese enlace no parece de Instagram. Revisa que sea un reel o un post.')
    }
    try {
      const data = await getInstagramMedia(args[0])
      if (!data) return msg.reply('No pude obtener ese contenido. Puede ser privado o el enlace no tiene medio descargable.')
      const caption = `*Instagram*\n\n${data.title ? `*Usuario:* ${data.title}\n` : ''}${data.caption ? `*Descripción:* ${data.caption}\n` : ''}${data.like ? `*Likes:* ${data.like}\n` : ''}${data.views ? `*Vistas:* ${data.views}\n` : ''}${data.duration ? `*Duración:* ${data.duration}\n` : ''}${data.format ? `*Formato:* ${data.format}\n` : ''}*Enlace:* ${args[0]}`
      if (data.type === 'video') {
        await sock.sendMessage(msg.chat, { video: { url: data.url }, caption, mimetype: 'video/mp4', fileName: 'ig.mp4' }, { quoted: msg })
      } else if (data.type === 'image') {
        await sock.sendMessage(msg.chat, { image: { url: data.url }, caption }, { quoted: msg })
      } else {
        throw new Error('Contenido no soportado.')
      }
    } catch (error) {
      console.error('[instagram] error:', error?.stack || error)
      await msg.reply('No pude descargar ese contenido de Instagram. Inténtalo más tarde.')
    }
  },
}
