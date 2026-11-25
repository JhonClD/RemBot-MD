// setgpname.js — Cambia el nombre del grupo. Autor: Jhon 𝗖𝗜𝗗.

export default {
  command: ['setgpname'],
  category: 'group',
  description: 'Cambia el nombre del grupo. Uso: setgpname <nuevo nombre>.',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, args }) => {
    const newName = args.join(' ').trim()
    if (!newName) {
      return msg.reply('Ingresa el nuevo nombre del grupo.')
    }
    try {
      await sock.groupUpdateSubject(msg.chat, newName)
      await msg.reply('El nombre del grupo se modificó correctamente.')
    } catch (e) {
      return msg.reply(`No se pudo cambiar el nombre del grupo. Error: ${e?.message || e}`)
    }
  },
}
