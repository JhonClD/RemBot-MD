// setgpbanner.js — Banner / imagen del grupo. Autor: Jhon 𝗖𝗜𝗗.
// Dos usos:
// 1) Con una URL: guarda la URL como banner del grupo en el store (gpbanner).
// 2) Respondiendo a una imagen (o con una imagen adjunta): cambia la foto
//    del grupo, como hacía YukiBot con updateProfilePicture.
import { updateChatSettings } from '../../lib/system/botstore.js'

export default {
  command: ['setgpbanner'],
  category: 'group',
  description: 'Guarda la URL del banner del grupo o cambia su foto. Uso: responde a una imagen, o setgpbanner <url>.',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const url = (args[0] || '').trim()
    if (/^https?:\/\//i.test(url)) {
      updateChatSettings(msg.chat, { gpbanner: url })
      return msg.reply(`Banner del grupo guardado: ${url}`)
    }
    const q = msg.quoted || msg
    const mime = String((q.msg || q).mimetype || q.mediaType || q.mtype || '')
    if (!/image/.test(mime)) {
      return msg.reply(`Responde a una imagen para cambiar la foto del grupo, o pasa una URL para guardar el banner.\nEjemplo: ${usedPrefix}${command} https://ejemplo.com/banner.jpg`)
    }
    let img = null
    try {
      img = typeof q.download === 'function' ? await q.download() : await msg.getMediaBuffer()
    } catch {}
    if (!img) return msg.reply('No se pudo descargar la imagen.')
    try {
      await sock.updateProfilePicture(msg.chat, img)
      await msg.reply('La imagen del grupo se actualizó.')
    } catch (e) {
      return msg.reply(`No se pudo actualizar la imagen del grupo. Error: ${e?.message || e}`)
    }
  },
}
