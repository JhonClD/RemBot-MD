// tiktok.js — Descargar un video o foto de TikTok.
// Autor: Jhon 𝗖𝗜𝗗. Solo API pública tikwm (sin key).
// Nota: la búsqueda por texto usaba la API privada de YukiBot y quedó fuera;
// este comando solo descarga desde un enlace.

const TIKTOK_RE = /(?:https:?\/{2})?(?:w{3}|vm|vt|t)?\.?tiktok\.com\/([^\s&]+)/i

async function fetchJson(url, timeout = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`Tikwm respondió HTTP ${res.status}.`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('es-PE')
}

function buildCaption({ title, author, duration, stats, createdAt }) {
  return `*TikTok*\n\n*Título:* ${title || 'Sin título'}\n*Autor:* ${author?.nickname || author?.unique_id || 'Desconocido'}${author?.unique_id ? ` (@${author.unique_id})` : ''}\n*Duración:* ${duration || 'N/A'}\n*Likes:* ${fmtNum(stats?.digg_count ?? stats?.likes)}\n*Comentarios:* ${fmtNum(stats?.comment_count ?? stats?.comments)}\n*Vistas:* ${fmtNum(stats?.play_count ?? stats?.views ?? stats?.plays)}\n*Compartidos:* ${fmtNum(stats?.share_count ?? stats?.shares)}\n*Fecha:* ${createdAt || 'N/A'}`
}

// Envía el álbum; si falla, manda las imágenes una por una.
async function sendMedias({ sock, chat, msg, medias }) {
  if (medias.length >= 2 && typeof sock.sendAlbumMessage === 'function') {
    try {
      await sock.sendAlbumMessage(chat, medias, { quoted: msg })
      return
    } catch (error) {
      console.error('[tiktok] álbum falló, mando una por una:', error?.message || error)
    }
  }
  for (const media of medias) {
    await sock.sendMessage(chat, { [media.type]: media.data, caption: media.caption }, { quoted: msg })
  }
}

export default {
  command: ['tiktok', 'tt'],
  category: 'downloads',
  description: 'Descarga un video o foto de TikTok. Uso: `tt <enlace de TikTok>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args?.length) {
      return msg.reply(`Pega un enlace de TikTok.\nEjemplo: *${usedPrefix}tt https://www.tiktok.com/@usuario/video/123456789*`)
    }
    const text = args.join(' ').trim()
    if (!TIKTOK_RE.test(text)) {
      return msg.reply('Necesito un enlace de TikTok. La búsqueda por texto no está disponible en este comando.')
    }
    try {
      const json = await fetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(text)}&hd=1`)
      const data = json?.data
      if (json?.code !== 0 || !data) {
        return msg.reply('No encontré contenido válido en ese enlace de TikTok.')
      }
      const caption = buildCaption({
        title: data.title,
        author: data.author,
        duration: data.duration,
        stats: data.stats,
        createdAt: data.create_time ? new Date(data.create_time * 1000).toLocaleDateString('es-PE') : null,
      })
      if (Array.isArray(data.images) && data.images.length) {
        const medias = data.images.map(url => ({ type: 'image', data: { url }, caption }))
        await sendMedias({ sock, chat: msg.chat, msg, medias })
        const audioUrl = data.music?.play
        if (audioUrl) {
          await sock.sendMessage(msg.chat, { audio: { url: audioUrl }, mimetype: 'audio/mp4', fileName: 'tiktok_audio.mp4' }, { quoted: msg })
        }
        return
      }
      const videoUrl = data.play || data.wmplay
      if (!videoUrl) {
        return msg.reply('Ese enlace no tiene video descargable.')
      }
      await sock.sendMessage(msg.chat, { video: { url: videoUrl }, caption }, { quoted: msg })
    } catch (error) {
      console.error('[tiktok] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar ese TikTok. Inténtalo más tarde.')
    }
  },
}
