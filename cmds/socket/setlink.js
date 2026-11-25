// setlink.js — Cambia el enlace del bot que muestra el menú.
// Portado de YukiBot-MD (cmds/socket/setlink.js), con la misma validación
// (debe empezar con http:// o https://) y guardado en el store.
// Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { updateBotSettings } from '../../lib/system/botstore.js'

export default {
  command: ['setlink', 'setbotlink'],
  category: 'socket',
  description: 'Cambia el enlace del bot. Usa setlink <url>.',
  isOwner: true,
  run: async ({ msg, args = [], usedPrefix, command }) => {
    try {
      const value = args.join(' ').trim()
      if (!value) {
        return msg.reply(`❎ Escribe el enlace del bot.\nEjemplo: *${usedPrefix}${command} https://ejemplo.com*`)
      }
      if (!/^https?:\/\//i.test(value)) {
        return msg.reply('❎ El enlace debe empezar con http:// o https://.')
      }
      updateBotSettings({ link: value })
      return msg.reply(`✅ Se cambió el enlace del bot a *${value}*.`)
    } catch (error) {
      console.error('[setlink] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el enlace. Inténtalo de nuevo.')
    }
  },
}
