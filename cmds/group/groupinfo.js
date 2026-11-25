// groupinfo.js — Muestra la información del grupo. Autor: Jhon 𝗖𝗜𝗗.
// Nota: no se portan los datos de economía/gacha/personajes de YukiBot
// (monedas, claims, usuarios registrados), porque RemBot no tiene esa base
// de datos. Tampoco los ajustes de antilink/antistatus/nsfw, que dependen
// del sistema de eventos que el coordinador no cablea en esta tanda.
import { getChatSettings, getMessageCounts } from '../../lib/system/botstore.js'

function formatDate(seconds) {
  if (!seconds) return 'Desconocida'
  return new Intl.DateTimeFormat('es-PE', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima',
  }).format(new Date(Number(seconds) * 1000))
}

export default {
  command: ['gp', 'groupinfo'],
  category: 'group',
  description: 'Muestra la información del grupo.',
  run: async ({ msg, sock }) => {
    try {
      const metadata = await sock.groupMetadata(msg.chat)
      const participants = metadata?.participants || []
      const admins = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      const settings = getChatSettings(msg.chat)
      const counts = getMessageCounts(msg.chat)
      const totalMessages = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0)
      const creator = metadata?.owner ? `@${metadata.owner.split('@')[0]}` : 'Desconocido'
      const text = [
        `Información del grupo: ${metadata?.subject || 'Sin nombre'}`,
        '',
        `Creador: ${creator}`,
        `Miembros: ${participants.length} (admins: ${admins.length})`,
        `Creado: ${formatDate(metadata?.creation)}`,
        `Estado: ${metadata?.announce ? 'cerrado (solo escriben los admins)' : 'abierto'}`,
        `Descripción: ${metadata?.desc || 'Sin descripción'}`,
        '',
        `Bot: ${settings.enabled ? 'activado' : 'desactivado'}`,
        `Bienvenida: ${settings.welcome ? 'configurada' : 'sin configurar'}`,
        `Despedida: ${settings.goodbye ? 'configurada' : 'sin configurar'}`,
        `Límite de advertencias: ${settings.warnLimit > 0 ? settings.warnLimit : 'desactivado'}`,
        `Mensajes contados: ${totalMessages}`,
      ].join('\n')
      const mentions = metadata?.owner ? [metadata.owner] : []
      let picture = null
      try { picture = await sock.profilePictureUrl(msg.chat, 'image') } catch {}
      if (picture) {
        await sock.sendMessage(msg.chat, { image: { url: picture }, caption: text, mentions }, { quoted: msg })
      } else {
        await sock.sendMessage(msg.chat, { text, mentions }, { quoted: msg })
      }
    } catch (e) {
      await msg.reply(`No se pudo obtener la información del grupo. Error: ${e?.message || e}`)
    }
  },
}
