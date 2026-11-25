// setstatus.js — Cambia el estado (info) del bot en WhatsApp y en el store.
// Portado de YukiBot-MD (cmds/socket/setstatus.js). El fuente solo aplicaba
// el estado con sock.updateProfileStatus sin guardarlo; aquí además queda en
// el store para que el menú lo muestre. Sin arte decorativo ni errores en
// inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { updateBotSettings } from '../../lib/system/botstore.js'

export default {
  command: ['setstatus'],
  category: 'socket',
  description: 'Cambia el estado del bot. Usa setstatus <texto>.',
  isOwner: true,
  run: async ({ msg, sock, args = [], usedPrefix, command }) => {
    try {
      const value = args.join(' ').trim()
      if (!value) {
        return msg.reply(`❎ Escribe el nuevo estado del bot.\nEjemplo: *${usedPrefix}${command} Hola, soy Rem*`)
      }
      if (value.length > 139) {
        return msg.reply('❎ El estado no puede tener más de 139 caracteres (límite de WhatsApp).')
      }
      await sock.updateProfileStatus(value)
      updateBotSettings({ status: value })
      return msg.reply(`✅ El estado del bot ahora es *${value}*.`)
    } catch (error) {
      console.error('[setstatus] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el estado del bot. Inténtalo de nuevo.')
    }
  },
}
