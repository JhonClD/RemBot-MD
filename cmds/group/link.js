// link.js — Muestra el enlace de invitación del grupo. Autor: Jhon 𝗖𝗜𝗗.

export default {
  command: ['link'],
  category: 'group',
  description: 'Muestra el enlace de invitación del grupo.',
  botAdmin: true,
  run: async ({ msg, sock }) => {
    try {
      const code = await sock.groupInviteCode(msg.chat)
      await sock.sendMessage(msg.chat, {
        text: `Enlace del grupo:\nhttps://chat.whatsapp.com/${code}\n\nSolicitado por @${msg.sender.split('@')[0]}`,
        mentions: [msg.sender],
      }, { quoted: msg })
    } catch (e) {
      await msg.reply(`No se pudo obtener el enlace del grupo. Error: ${e?.message || e}`)
    }
  },
}
