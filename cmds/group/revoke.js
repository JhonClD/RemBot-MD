// revoke.js — Restablece el enlace de invitación del grupo. Autor: Jhon 𝗖𝗜𝗗.

export default {
  command: ['revoke', 'restablecer'],
  category: 'group',
  description: 'Restablece el enlace de invitación del grupo y muestra el nuevo.',
  botAdmin: true,
  run: async ({ msg, sock }) => {
    try {
      await msg.react('🕒').catch(() => {})
      await sock.groupRevokeInvite(msg.chat)
      const code = await sock.groupInviteCode(msg.chat)
      await sock.sendMessage(msg.chat, {
        text: `El enlace del grupo ha sido restablecido.\n\nNuevo enlace:\nhttps://chat.whatsapp.com/${code}\n\nSolicitado por @${msg.sender.split('@')[0]}`,
        mentions: [msg.sender],
      }, { quoted: msg })
      await msg.react('✔️').catch(() => {})
    } catch (e) {
      await msg.react('✖️').catch(() => {})
      await msg.reply(`No se pudo restablecer el enlace del grupo. Error: ${e?.message || e}`)
    }
  },
}
