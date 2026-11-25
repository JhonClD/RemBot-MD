// hidetag.js — Envía un mensaje mencionando a todos los miembros. Autor: Jhon 𝗖𝗜𝗗.

// Detecta el tipo de medio del mensaje citado o del propio mensaje.
function mediaKind(src) {
  const type = src?.mtype || src?.type || ''
  if (type === 'imageMessage' || src?.message?.imageMessage) return 'image'
  if (type === 'videoMessage' || src?.message?.videoMessage) return 'video'
  if (type === 'audioMessage' || src?.message?.audioMessage) return 'audio'
  if (type === 'stickerMessage' || src?.message?.stickerMessage) return 'sticker'
  return null
}

async function downloadSource(src, fallback) {
  if (typeof src?.download === 'function') return src.download()
  if (typeof fallback === 'function') return fallback()
  return null
}

export default {
  command: ['hidetag', 'tag'],
  category: 'group',
  description: 'Envía un mensaje mencionando a todos los miembros del grupo. Uso: hidetag <texto> o responde a un mensaje o medio.',
  isAdmin: true,
  run: async ({ msg, sock, args, participants }) => {
    const mentions = (participants || []).map(p => p.id).filter(Boolean)
    const userText = (args.join(' ') || '').trim()
    const src = msg.quoted || msg
    const kind = mediaKind(src)
    const isQuoted = Boolean(msg.quoted)
    const originalText = (src.caption || src.text || src.body || '').trim()
    try {
      if (kind === 'image' || kind === 'video') {
        const media = await downloadSource(src, () => msg.getMediaBuffer())
        if (!media) return msg.reply('No se pudo descargar el medio.')
        const caption = isQuoted ? originalText : userText
        if (kind === 'image') {
          return sock.sendMessage(msg.chat, { image: media, ...(caption ? { caption } : {}), mentions })
        }
        return sock.sendMessage(msg.chat, { video: media, mimetype: 'video/mp4', ...(caption ? { caption } : {}), mentions })
      }
      if (kind === 'audio') {
        const media = await downloadSource(src, () => msg.getMediaBuffer())
        if (!media) return msg.reply('No se pudo descargar el audio.')
        return sock.sendMessage(msg.chat, { audio: media, mimetype: 'audio/mp4', fileName: 'hidetag.mp3', mentions })
      }
      if (kind === 'sticker') {
        const media = await downloadSource(src, () => msg.getMediaBuffer())
        if (!media) return msg.reply('No se pudo descargar el sticker.')
        return sock.sendMessage(msg.chat, { sticker: media, mentions })
      }
      if (isQuoted && originalText) {
        return sock.sendMessage(msg.chat, { text: originalText, mentions })
      }
      if (userText) {
        return sock.sendMessage(msg.chat, { text: userText, mentions })
      }
      return msg.reply('Ingresa un texto o responde a un mensaje o medio.')
    } catch (e) {
      return msg.reply(`No se pudo enviar el mensaje. Error: ${e?.message || e}`)
    }
  },
}
