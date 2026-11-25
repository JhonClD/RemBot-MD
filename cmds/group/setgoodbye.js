// setgoodbye.js — Mensaje de despedida personalizado del grupo. Autor: Jhon 𝗖𝗜𝗗.
// El texto se guarda en el store; el evento de despedida lo envía cuando
// un miembro sale (lo cablea el coordinador). Sin texto guardado no hay
// mensaje: no existe un interruptor on/off separado en el store.
import { getChatSettings, updateChatSettings } from '../../lib/system/botstore.js'

function helpText(usedPrefix, command) {
  return `Configurar mensaje de despedida\n\nVariables disponibles:\n- @user — Mención del usuario que sale\n- @group — Nombre del grupo\n- @desc — Descripción del grupo\n- @members — Número de miembros actuales\n- @time — Fecha y hora\n\nEjemplo: ${usedPrefix}${command} Adiós @user, te extrañaremos\nPara borrarlo: ${usedPrefix}${command} clear`
}

export default {
  command: ['setgoodbye'],
  category: 'group',
  description: 'Establece el mensaje de despedida del grupo. Uso: setgoodbye <texto> | setgoodbye clear.',
  isAdmin: true,
  run: async ({ msg, args, usedPrefix, command }) => {
    if (!args.length) {
      return msg.reply(helpText(usedPrefix, command))
    }
    if (args[0].toLowerCase() === 'clear') {
      if (!getChatSettings(msg.chat).goodbye) {
        return msg.reply('No tienes ningún mensaje de despedida definido.')
      }
      updateChatSettings(msg.chat, { goodbye: '' })
      return msg.reply('Mensaje de despedida eliminado.')
    }
    const texto = args.join(' ')
    updateChatSettings(msg.chat, { goodbye: texto })
    await msg.reply('Mensaje de despedida guardado.')
  },
}
