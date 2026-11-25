// promote.js — Asciende a un usuario a administrador. Autor: Jhon 𝗖𝗜𝗗.

// Base numérica de un JID (sin @s.whatsapp.net, sin :dispositivo).
function base(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

export default {
  command: ['promote', 'promover'],
  category: 'group',
  description: 'Asciende a un usuario a administrador. Uso: promote @usuario.',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, participants }) => {
    const who = msg.mentionedJid?.[0] || msg.quoted?.sender
    if (!who) return msg.reply('Menciona al usuario que quieres promover a administrador.')
    try {
      const whoBase = base(who)
      const participant = (participants || []).find(p => base(p.id) === whoBase || base(p.lid) === whoBase)
      if (participant?.admin) {
        return sock.sendMessage(msg.chat, {
          text: `@${whoBase} ya es administrador del grupo.`,
          mentions: [who],
        }, { quoted: msg })
      }
      const targetJid = participant?.id || who
      await sock.groupParticipantsUpdate(msg.chat, [targetJid], 'promote')
      await sock.sendMessage(msg.chat, {
        text: `@${whoBase} ha sido promovido a administrador del grupo.`,
        mentions: [who],
      }, { quoted: msg })
    } catch (e) {
      await msg.reply(`No se pudo promover al usuario. Error: ${e?.message || e}`)
    }
  },
}
