// pinterest.js — Buscar y descargar imágenes y videos de Pinterest.
// Autor: Jhon 𝗖𝗜𝗗. Usa la API pública fare.ink (sin key).
// Si el texto es un enlace, descarga ese pin; si no, busca y manda un álbum.

async function fetchJson(url, timeout = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function getPinterestDownload(url) {
  try {
    const res = await fetchJson(`https://fare.ink/dl/pin?url=${encodeURIComponent(url)}`)
    if (!res?.status || !res.resultado?.url) return null
    const data = res.resultado
    const filename = data.filename || ''
    const mediaUrl = data.url || ''
    const isVideo = /\.mp4(?:$|\?)/i.test(filename) || /\.mp4(?:$|\?)/i.test(mediaUrl)
    const ext = filename.split('.').pop() || (isVideo ? 'mp4' : 'jpg')
    return {
      type: isVideo ? 'video' : 'image',
      id: data.id || null,
      title: data.titulo || null,
      description: null,
      author: data.autor || null,
      format: ext,
      url: mediaUrl,
      thumbnail: data.thumbnail || mediaUrl,
      filename: filename || `pinterest.${ext}`,
    }
  } catch {
    return null
  }
}

async function getPinterestSearch(query) {
  try {
    const res = await fetchJson(`https://fare.ink/search/pin?q=${encodeURIComponent(query)}&limit=20`)
    if (!res?.status || !Array.isArray(res.results) || !res.results.length) return []
    return res.results
      .filter(d => d?.descarga)
      .map(d => {
        const tipo = String(d.tipo || '').toLowerCase()
        const descarga = d.descarga || null
        const isVideo = tipo === 'video' || /\.mp4(?:$|\?)/i.test(descarga || '')
        return {
          type: isVideo ? 'video' : 'image',
          title: d.titulo || null,
          name: d.autor || null,
          likes: d.likes || null,
          image: descarga,
          url: d.url || null,
        }
      })
  } catch {
    return []
  }
}

// Envía el álbum; si falla, manda las imágenes una por una.
async function sendMedias({ sock, chat, msg, medias }) {
  if (medias.length >= 2 && typeof sock.sendAlbumMessage === 'function') {
    try {
      await sock.sendAlbumMessage(chat, medias, { quoted: msg })
      return
    } catch (error) {
      console.error('[pinterest] álbum falló, mando una por una:', error?.message || error)
    }
  }
  for (const media of medias) {
    await sock.sendMessage(chat, { [media.type]: media.data, caption: media.caption }, { quoted: msg })
  }
}

export default {
  command: ['pinterest', 'pin'],
  category: 'downloads',
  description: 'Busca o descarga de Pinterest. Uso: `pin <búsqueda>` o `pin <enlace del pin>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    const text = args.join(' ').trim()
    if (!text) {
      return msg.reply(`Escribe una búsqueda o pega un enlace de Pinterest.\nEjemplos:\n*${usedPrefix}pin gatos*\n*${usedPrefix}pin https://www.pinterest.com/pin/123456/*`)
    }
    try {
      if (/^https?:\/\//.test(text)) {
        const data = await getPinterestDownload(text)
        if (!data) return msg.reply('No pude obtener ese pin. Revisa el enlace e inténtalo de nuevo.')
        const caption = `*Pinterest*\n\n${data.title ? `*Título:* ${data.title}\n` : ''}${data.author ? `*Autor:* ${data.author}\n` : ''}${data.format ? `*Formato:* ${data.format}\n` : ''}*Enlace:* ${text}`
        if (data.type === 'video') {
          await sock.sendMessage(msg.chat, { video: { url: data.url }, caption, mimetype: 'video/mp4', fileName: data.filename || 'pin.mp4' }, { quoted: msg })
        } else if (data.type === 'image') {
          await sock.sendMessage(msg.chat, { image: { url: data.url }, caption }, { quoted: msg })
        } else {
          throw new Error('Contenido no soportado.')
        }
        return
      }
      const results = await getPinterestSearch(text)
      if (!results?.length) {
        return msg.reply(`No encontré resultados para *${text}*.`)
      }
      const medias = results
        .slice(0, 10)
        .filter(r => r.image)
        .map(r => ({
          type: r.type === 'video' ? 'video' : 'image',
          data: { url: r.image },
          caption: `*Pinterest*\n\n${r.title ? `*Título:* ${r.title}\n` : ''}${r.name ? `*Autor:* ${r.name}\n` : ''}${r.likes ? `*Likes:* ${r.likes}\n` : ''}${r.url ? `*Enlace:* ${r.url}\n` : ''}`,
        }))
      if (!medias.length) {
        return msg.reply(`No pude obtener descargas válidas para *${text}*.`)
      }
      await sendMedias({ sock, chat: msg.chat, msg, medias })
    } catch (error) {
      console.error('[pinterest] error:', error?.stack || error)
      await msg.reply('No pude buscar en Pinterest ahora. Inténtalo más tarde.')
    }
  },
}
