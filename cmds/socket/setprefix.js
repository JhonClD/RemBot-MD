// setprefix.js — Cambia el prefijo de comandos del bot.
// Portado de YukiBot-MD (cmds/socket/setprefix.js), adaptado al store de
// RemBot (lib/system/botstore.js), que guarda UN solo símbolo.
// Diferencias con el fuente:
// - Yuki aceptaba varios prefijos a la vez, modo sin prefijo (`noprefix`) y
//   `reset` a una lista de 4 símbolos. El store de RemBot solo admite un
//   símbolo, así que aquí solo se acepta un símbolo; `reset` vuelve al
//   prefijo por defecto (`) y `noprefix`/multi-prefijo NO se portan.
// - El prefijo activo sale del store: handler.js y lib/utils.js ya lo leen,
//   así que el cambio aplica de inmediato y `menu` lo muestra con getPrefix().
// - Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { DEFAULT_PREFIX, getPrefix, setPrefix } from '../../lib/system/botstore.js'

export default {
  command: ['setprefix', 'setbotprefix'],
  category: 'socket',
  description: 'Cambia el prefijo del bot. Usa setprefix <símbolo>.',
  isOwner: true,
  run: async ({ msg, args = [], usedPrefix, command }) => {
    try {
      const value = args.join(' ').trim()
      if (!value) {
        return msg.reply(`❎ Escribe el nuevo prefijo (un solo símbolo).\nEjemplo: *${usedPrefix}${command} !*\n\nPrefijo actual: *${getPrefix()}*\nPara volver al prefijo por defecto usa *${usedPrefix}${command} reset*`)
      }
      if (value.toLowerCase() === 'reset') {
        const result = setPrefix(DEFAULT_PREFIX)
        if (!result.ok) return msg.reply(`❎ ${result.error}`)
        return msg.reply(`✅ Se restauró el prefijo por defecto: *${result.prefix}*\n\nEl cambio aplica de inmediato.`)
      }
      const result = setPrefix(value)
      if (!result.ok) {
        return msg.reply(`❎ ${result.error}\nEjemplo: *${usedPrefix}${command} !*`)
      }
      return msg.reply(`✅ Se cambió el prefijo del bot a *${result.prefix}*.\n\nEl cambio aplica de inmediato.`)
    } catch (error) {
      console.error('[setprefix] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el prefijo. Inténtalo de nuevo.')
    }
  },
}
