// setchannel.js — Cambia el canal de WhatsApp del bot.
// Portado de YukiBot-MD (cmds/socket/setchannel.js): valida el enlace del
// canal, lee su nombre con sock.newsletterMetadata('invite', id) y guarda el
// id y el nombre en el store (channelId / channelName) para que el menú los
// muestre. Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { updateBotSettings } from '../../lib/system/botstore.js'

export default {
  command: ['setchannel', 'setbotchannel'],
  category: 'socket',
  description: 'Cambia el canal del bot. Usa setchannel <enlace del canal>.',
  isOwner: true,
  run: async ({ msg, sock, args = [], usedPrefix, command }) => {
    try {
      const value = args.join(' ').trim()
      if (!value) {
        return msg.reply(`❎ Escribe el enlace de un canal de WhatsApp.\nEjemplo: *${usedPrefix}${command} https://whatsapp.com/channel/0029VaXXXXXXXXXXXXXXXX*`)
      }
      const channelId = value.match(/(?:https:\/\/)?(?:www\.)?(?:chat\.|wa\.)?whatsapp\.com\/channel\/([0-9A-Za-z]{22,24})/i)?.[1]
      if (!channelId) {
        return msg.reply('❎ El enlace no es un enlace válido de canal de WhatsApp.')
      }
      if (typeof sock?.newsletterMetadata !== 'function') {
        return msg.reply('❎ Esta sesión de Baileys no permite leer canales. Actualiza Baileys e inténtalo de nuevo.')
      }
      let info
      try {
        info = await sock.newsletterMetadata('invite', channelId)
      } catch {
        info = null
      }
      if (!info) {
        return msg.reply('❎ No se pudo obtener la información del canal. Revisa el enlace e inténtalo de nuevo.')
      }
      const channelName = String(info.thread_metadata?.name?.text || info.name || 'Canal sin nombre').trim()
      updateBotSettings({ channelId: String(info.id || channelId), channelName })
      return msg.reply(`✅ Se cambió el canal del bot a *${channelName}*.`)
    } catch (error) {
      console.error('[setchannel] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el canal. Inténtalo de nuevo.')
    }
  },
}
