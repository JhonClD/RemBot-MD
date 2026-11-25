// setowner.js — Cambia el dueño del bot (guardado en el store).
// Portado de YukiBot-MD (cmds/socket/setowner.js). Diferencias con el fuente:
// - Yuki tenía un caso especial para números de México (52 + '1'); aquí no:
//   se acepta cualquier número de 10 a 15 dígitos y se guarda como
//   <dígitos>@s.whatsapp.net.
// - El dueño se guarda con setOwnerJid del store. handler.js ya suma ese
//   dueño a los owners con permiso, así que el cambio aplica de inmediato.
// - Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import { getBotSettings, getOwnerJid, setOwnerJid } from '../../lib/system/botstore.js'

function numberOf(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '')
}

export default {
  command: ['setowner', 'setbotowner'],
  category: 'socket',
  description: 'Cambia el dueño del bot. Usa setowner @usuario, setowner <número> o setowner clear.',
  isOwner: true,
  run: async ({ msg, sock, args = [], usedPrefix, command }) => {
    try {
      const settings = getBotSettings()
      const text = args.join(' ').trim()
      const current = getOwnerJid()

      if (text.toLowerCase() === 'clear') {
        if (!current) return msg.reply('❎ No hay ningún dueño asignado actualmente.')
        setOwnerJid('')
        return msg.reply('✅ Se eliminó el dueño asignado.')
      }

      const mentioned = msg.mentionedJid?.[0] || null
      const quoted = msg.quoted?.sender || null
      const digits = text.replace(/\D/g, '')
      const next = mentioned || quoted || (digits.length >= 10 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null)

      if (!next) {
        if (current) {
          return sock.sendMessage(msg.chat, { text: `Ya tienes un dueño asignado: @${numberOf(current)}.\n\nPara cambiarlo usa:\n> *${usedPrefix}${command}* @usuario\n\nPara eliminarlo usa:\n> *${usedPrefix}${command} clear*`, mentions: [current] }, { quoted: msg })
        }
        return msg.reply(`❎ Menciona al nuevo dueño del bot.\nEjemplo: *${usedPrefix}${command}* @usuario`)
      }

      if (current && current === next) {
        return msg.reply(`El dueño ya es @${numberOf(next)}.`)
      }
      setOwnerJid(next)
      const oldPart = current ? ` de @${numberOf(current)} a @${numberOf(next)}` : ` a @${numberOf(next)}`
      return sock.sendMessage(msg.chat, { text: `✅ Se cambió el dueño${oldPart} de *${settings.name || 'RemBot-MD'}*.\n\nEl cambio de permisos aplica de inmediato.`, mentions: [next, ...(current && current !== next ? [current] : [])] }, { quoted: msg })
    } catch (error) {
      console.error('[setowner] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el dueño. Inténtalo de nuevo.')
    }
  },
}
