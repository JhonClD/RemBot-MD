// setgpdesc.js — Cambia la descripción del grupo. Autor: Jhon 𝗖𝗜𝗗.

export default {
  command: ['setgpdesc'],
  category: 'group',
  description: 'Cambia la descripción del grupo. Uso: setgpdesc <nueva descripción>.',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, args }) => {
    const newDesc = args.join(' ').trim()
    if (!newDesc) {
      return msg.reply('Ingresa la nueva descripción del grupo.')
    }
    try {
      await sock.groupUpdateDescription(msg.chat, newDesc)
      await msg.reply('La descripción del grupo se modificó correctamente.')
    } catch (e) {
      return msg.reply(`No se pudo cambiar la descripción del grupo. Error: ${e?.message || e}`)
    }
  },
}
