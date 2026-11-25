// setname.js — Cambia el nombre del bot en WhatsApp y en el store.
// Portado de YukiBot-MD (cmds/socket/setname.js y setusername.js).
// Diferencias con los fuentes:
// - Yuki setname guardaba un nombre corto y uno largo separados por '/' en la
//   DB y NO tocaba el perfil de WhatsApp; RemBot tiene un solo campo `name`
//   en el store, así que se usa un solo nombre y además se aplica al perfil
//   con sock.updateProfileName.
// - Yuki setusername solo llamaba a sock.updateProfileName con el texto, sin
//   usar ninguna API de nombre de usuario: es lo mismo que hace este comando,
//   así que `setusername` queda como alias aquí y NO se porta como archivo
//   aparte.
// - Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { updateBotSettings } from '../../lib/system/botstore.js'

export default {
  command: ['setname', 'setbotname', 'setusername'],
  category: 'socket',
  description: 'Cambia el nombre del bot. Usa setname <nombre>.',
  isOwner: true,
  run: async ({ msg, sock, args = [], usedPrefix, command }) => {
    try {
      const value = args.join(' ').trim()
      if (!value) {
        return msg.reply(`❎ Escribe el nuevo nombre del bot.\nEjemplo: *${usedPrefix}${command} Rem*`)
      }
      if (value.length > 25) {
        return msg.reply('❎ El nombre del bot no puede tener más de 25 caracteres (límite de WhatsApp).')
      }
      await sock.updateProfileName(value)
      updateBotSettings({ name: value })
      return msg.reply(`✅ El nombre del bot ahora es *${value}*.`)
    } catch (error) {
      console.error('[setname] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el nombre del bot. Inténtalo de nuevo.')
    }
  },
}
