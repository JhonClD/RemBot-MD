// setwelcome.js — Mensaje de bienvenida personalizado del grupo. Autor: Jhon 𝗖𝗜𝗗.
// El texto se guarda en el store; el evento de bienvenida lo envía cuando
// un miembro entra (lo cablea el coordinador). Sin texto guardado no hay
// mensaje: no existe un interruptor on/off separado en el store.
import { getChatSettings, updateChatSettings } from '../../lib/system/botstore.js'

function helpText(usedPrefix, command) {
  return `Configurar mensaje de bienvenida\n\nVariables disponibles:\n- @user — Mención del usuario que entra\n- @group — Nombre del grupo\n- @desc — Descripción del grupo\n- @members — Número de miembros actuales\n- @time — Fecha y hora\n\nEjemplo: ${usedPrefix}${command} Bienvenido @user a @group\nPara borrarlo: ${usedPrefix}${command} clear`
}

export default {
  command: ['setwelcome'],
  category: 'group',
  description: 'Establece el mensaje de bienvenida del grupo. Uso: setwelcome <texto> | setwelcome clear.',
  isAdmin: true,
  run: async ({ msg, args, usedPrefix, command }) => {
    if (!args.length) {
      return msg.reply(helpText(usedPrefix, command))
    }
    if (args[0].toLowerCase() === 'clear') {
      if (!getChatSettings(msg.chat).welcome) {
        return msg.reply('No tienes ningún mensaje de bienvenida definido.')
      }
      updateChatSettings(msg.chat, { welcome: '' })
      return msg.reply('Mensaje de bienvenida eliminado.')
    }
    const texto = args.join(' ')
    updateChatSettings(msg.chat, { welcome: texto })
    await msg.reply('Mensaje de bienvenida guardado.')
  },
}
