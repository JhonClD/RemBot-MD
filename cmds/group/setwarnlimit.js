// setwarnlimit.js — Límite de advertencias del grupo. Autor: Jhon 𝗖𝗜𝗗.
// 0 desactiva la expulsión automática. El store solo guarda warnLimit
// (sin el flag `expulsar` separado de YukiBot): límite 0 = desactivado.
import { getChatSettings, updateChatSettings } from '../../lib/system/botstore.js'

export default {
  command: ['setwarnlimit'],
  category: 'group',
  description: 'Establece el límite de advertencias del grupo (1-10, o 0 para desactivar la expulsión). Uso: setwarnlimit <número>.',
  isAdmin: true,
  run: async ({ msg, args, usedPrefix, command }) => {
    const settings = getChatSettings(msg.chat)
    const limit = parseInt(args[0], 10)
    if (Number.isNaN(limit) || limit < 0 || limit > 10) {
      return msg.reply(`El límite debe ser un número entre 1 y 10, o 0 para desactivar la expulsión automática.\nEjemplo: ${usedPrefix}${command} 5\n\nEstado actual: ${settings.warnLimit > 0 ? `${settings.warnLimit} advertencias` : 'desactivado'}`)
    }
    if (limit === 0) {
      updateChatSettings(msg.chat, { warnLimit: 0 })
      return msg.reply('Expulsión automática por advertencias desactivada.')
    }
    updateChatSettings(msg.chat, { warnLimit: limit })
    await msg.reply(`Límite de advertencias establecido en ${limit} para este grupo.\nLos usuarios serán expulsados automáticamente al alcanzar este límite.`)
  },
}
