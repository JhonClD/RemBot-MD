// setpfp.js — Cambia la foto de perfil del bot en WhatsApp.
// Portado de YukiBot-MD (cmds/socket/setpfp.js). Diferencias con el fuente:
// - El fuente tenía una rama `full` que usaba `sock.query` con una variable
//   `attrs` que no existe (rompería con ReferenceError) y dependía de Jimp,
//   que RemBot no tiene instalado. Esa rama NO se porta: solo se usa
//   sock.updateProfilePicture, que es lo que hacía la rama normal.
// - Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { getBotSettings } from '../../lib/system/botstore.js'

function mimeOf(target) {
  return String(target?.mimetype || target?.msg?.mimetype || target?.content?.mimetype || '')
}

export default {
  command: ['setpfp', 'setimage'],
  category: 'socket',
  description: 'Cambia la foto de perfil del bot. Cita una imagen con setpfp.',
  isOwner: true,
  run: async ({ msg, sock, usedPrefix }) => {
    try {
      const settings = getBotSettings()
      const quoted = msg.quoted || msg
      const mime = mimeOf(quoted)
      if (!/^image\//i.test(mime)) {
        return msg.reply(`❎ Cita una imagen para cambiar la foto de perfil.\nEjemplo: cita la imagen y escribe *${usedPrefix}setpfp*`)
      }
      if (typeof quoted.download !== 'function') {
        return msg.reply('❎ No se pudo descargar la imagen. Inténtalo de nuevo.')
      }
      const media = await quoted.download()
      if (!media || !Buffer.isBuffer(media) || media.length === 0) {
        return msg.reply('❎ No se pudo descargar la imagen. Inténtalo de nuevo.')
      }
      const botJid = String(sock?.user?.id || '').split(':')[0] + '@s.whatsapp.net'
      await sock.updateProfilePicture(botJid, media)
      return msg.reply(`✅ Se actualizó la foto de perfil de *${settings.name || 'RemBot-MD'}*.`)
    } catch (error) {
      console.error('[setpfp] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar la foto de perfil. Revisa que la imagen sea válida e inténtalo de nuevo.')
    }
  },
}
