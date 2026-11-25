// seticon.js — Cambia el icono del bot de RemBot-MD.
// Portado de YukiBot-MD (cmds/socket/seticon.js). Diferencias con el fuente:
// - Yuki subía la imagen a un servicio de terceros (cdn.adoolab.xyz); aquí NO
//   se usa ningún uploader externo: la media citada se guarda en local
//   (assets/rem-icon.<ext>) y esa ruta queda en el store.
// - En Yuki el icono se guardaba en la DB pero nunca se mostraba en el menú;
//   aquí help.js lo usa como imagen del menú cuando no hay banner.
// - Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBotSettings, updateBotSettings } from '../../lib/system/botstore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const ASSETS_DIR = path.join(REPO_ROOT, 'assets')

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i

function extensionFor(mime) {
  if (/png/i.test(mime)) return 'png'
  if (/gif/i.test(mime)) return 'gif'
  if (/webp/i.test(mime)) return 'webp'
  return 'jpg'
}

function mimeOf(target) {
  return String(target?.mimetype || target?.msg?.mimetype || target?.content?.mimetype || '')
}

export default {
  command: ['seticon', 'setboticon'],
  category: 'socket',
  description: 'Cambia el icono del bot. Usa seticon <url> o cita una imagen.',
  isOwner: true,
  run: async ({ msg, args = [], usedPrefix }) => {
    try {
      const settings = getBotSettings()
      const value = args.join(' ').trim()

      if (value) {
        if (!/^https?:\/\//i.test(value)) {
          return msg.reply(`❎ El icono debe ser una URL que empiece con http:// o https://.\nEjemplo: *${usedPrefix}seticon* https://ejemplo.com/icono.jpg\n\nTambién puedes citar una imagen con *${usedPrefix}seticon* sin texto.`)
        }
        updateBotSettings({ icon: value })
        return msg.reply(`✅ Se actualizó el icono de *${settings.name || 'RemBot-MD'}*.`)
      }

      const quoted = msg.quoted || msg
      const mime = mimeOf(quoted)
      if (!IMAGE_MIME.test(mime)) {
        return msg.reply(`❎ Cita una imagen (PNG, JPG, GIF o WebP) para cambiar el icono.\nEjemplo: cita la imagen y escribe *${usedPrefix}seticon*`)
      }
      if (typeof quoted.download !== 'function') {
        return msg.reply('❎ No se pudo descargar la imagen. Inténtalo de nuevo.')
      }
      const media = await quoted.download()
      if (!media || !Buffer.isBuffer(media) || media.length === 0) {
        return msg.reply('❎ No se pudo descargar la imagen. Inténtalo de nuevo.')
      }
      const ext = extensionFor(mime)
      const fileName = `rem-icon.${ext}`
      await fs.mkdir(ASSETS_DIR, { recursive: true })
      await fs.writeFile(path.join(ASSETS_DIR, fileName), media)
      updateBotSettings({ icon: `assets/${fileName}` })
      return msg.reply(`✅ Se actualizó el icono de *${settings.name || 'RemBot-MD'}* (guardado en assets/${fileName}).`)
    } catch (error) {
      console.error('[seticon] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el icono. Inténtalo de nuevo.')
    }
  },
}
