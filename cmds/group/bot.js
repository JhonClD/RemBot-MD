// bot.js — Activa o desactiva el bot en el grupo. Autor: Jhon 𝗖𝗜𝗗.
import { getBotSettings, getChatSettings, updateChatSettings } from '../../lib/system/botstore.js'

export default {
  command: ['bot'],
  category: 'group',
  description: 'Activa o desactiva el bot en este grupo. Uso: bot on / bot off.',
  isAdmin: true,
  run: async ({ msg, args, usedPrefix, command }) => {
    const settings = getChatSettings(msg.chat)
    const name = getBotSettings().name || 'RemBot'
    const arg = String(args[0] || '').toLowerCase()
    if (arg === 'off') {
      if (!settings.enabled) return msg.reply('El bot ya estaba desactivado en este grupo.')
      updateChatSettings(msg.chat, { enabled: false })
      return msg.reply(`Has desactivado a ${name} en este grupo.`)
    }
    if (arg === 'on') {
      if (settings.enabled) return msg.reply(`${name} ya estaba activado en este grupo.`)
      updateChatSettings(msg.chat, { enabled: true })
      return msg.reply(`Has activado a ${name} en este grupo.`)
    }
    return msg.reply(`Estado de ${name}: ${settings.enabled ? 'activado' : 'desactivado'}.\n\nPuedes cambiarlo con:\n- Activar: ${usedPrefix}${command} on\n- Desactivar: ${usedPrefix}${command} off`)
  },
}
