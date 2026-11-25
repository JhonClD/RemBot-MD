// twitter.js — Descargar un video o imagen de Twitter/X.
// Autor: Jhon 𝗖𝗜𝗗. Solo APIs públicas sin key (Delirius, Zenzxz),
// probadas en orden hasta que una devuelva el medio.

const APIS = [
  {
    name: 'Delirius',
    endpoint: url => `https://api.delirius.online/download/twitterdl?url=${encodeURIComponent(url)}`,
    extractor: res => {
      if (!res?.found || !res.media?.length) return null
      return {
        type: res.type || 'video',
        title: res.info?.text || null,
        author: res.info?.user_name || res.info?.user_screen_name || null,
        date: res.info?.date || null,
        url: res.media[0]?.url || null,
        likes: res.info?.likes || null,
        comments: res.info?.replies || null,
        retweets: res.info?.retweets || null,
      }
    },
  },
  {
    name: 'Zenzxz',
    endpoint: url => `https://api.zenzxz.my.id/download/twitter?url=${encodeURIComponent(url)}`,
    extractor: res => {
      if (!res?.status || !res.result?.length) return null
      const hd = res.result.find(x => String(x.quality || '').includes('1080') || String(x.quality || '').includes('HD'))
      const sd = res.result.find(x => String(x.quality || '').includes('720'))
      const media = hd || sd || res.result[0]
      if (!media?.url) return null
      return { type: 'video', resolution: media.quality || null, url: media.url }
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

async function getTwitterMedia(url) {
  for (const api of APIS) {
    try {
      const result = api.extractor(await fetchJson(api.endpoint(url)))
      if (result?.url) return result
    } catch (error) {
      console.error(`[twitter] ${api.name} falló:`, error?.message || error)
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

export default {
  command: ['twitter', 'x'],
  category: 'downloads',
  description: 'Descarga un video o imagen de Twitter/X. Uso: `x <enlace del post>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args[0]) {
      return msg.reply(`Pega un enlace de Twitter/X.\nEjemplo: *${usedPrefix}x https://x.com/usuario/status/123456789*`)
    }
    if (!/(twitter|x)\.com\/\w+\/status\//.test(args[0])) {
      return msg.reply('Ese enlace no parece de Twitter/X. Revisa que sea un post con video o imagen.')
    }
    try {
      const data = await getTwitterMedia(args[0])
      if (!data) return msg.reply('No pude obtener ese contenido. Puede ser privado o el post no tiene medio descargable.')
      const caption = `*Twitter/X*\n\n${data.title ? `*Texto:* ${data.title}\n` : ''}${data.author ? `*Autor:* ${data.author}\n` : ''}${data.date ? `*Fecha:* ${data.date}\n` : ''}${data.duration ? `*Duración:* ${data.duration}\n` : ''}${data.resolution ? `*Resolución:* ${data.resolution}\n` : ''}${data.views ? `*Vistas:* ${data.views}\n` : ''}${data.likes ? `*Likes:* ${data.likes}\n` : ''}${data.comments ? `*Comentarios:* ${data.comments}\n` : ''}${data.retweets ? `*Retweets:* ${data.retweets}\n` : ''}*Enlace:* ${args[0]}`
      if (data.type === 'video') {
        await sock.sendMessage(msg.chat, { video: { url: data.url }, caption, mimetype: 'video/mp4', fileName: 'twitter.mp4' }, { quoted: msg })
      } else if (data.type === 'image') {
        await sock.sendMessage(msg.chat, { image: { url: data.url }, caption }, { quoted: msg })
      } else {
        throw new Error('Contenido no soportado.')
      }
    } catch (error) {
      console.error('[twitter] error:', error?.stack || error)
      await msg.reply('No pude descargar ese contenido de Twitter/X. Inténtalo más tarde.')
    }
  },
}
