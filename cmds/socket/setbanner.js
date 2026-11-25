// setbanner.js — Cambia el banner del menú de RemBot-MD.
// Portado de YukiBot-MD (cmds/socket/setbanner.js). Diferencias con el fuente:
// - Yuki subía la imagen a un servicio de terceros (cdn.adoolab.xyz); aquí NO
//   se usa ningún uploader externo: la media citada se guarda en local
//   (assets/rem-banner.<ext>) y esa ruta queda en el store.
// - La variante por URL guarda la URL tal cual en el store.
// - Sin arte decorativo ni errores en inglés. Crédito: Jhon 𝗖𝗜𝗗.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBotSettings, updateBotSettings } from '../../lib/system/botstore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const ASSETS_DIR = path.join(REPO_ROOT, 'assets')

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i
const VIDEO_MIME = /^video\/mp4$/i

function extensionFor(mime) {
  if (/png/i.test(mime)) return 'png'
  if (/gif/i.test(mime)) return 'gif'
  if (/webp/i.test(mime)) return 'webp'
  if (/mp4/i.test(mime)) return 'mp4'
  return 'jpg'
}

function mimeOf(target) {
  return String(target?.mimetype || target?.msg?.mimetype || target?.content?.mimetype || '')
}

async function downloadMedia(target) {
  if (typeof target?.download === 'function') return target.download()
  return null
}

export default {
  command: ['setbanner', 'setbotbanner'],
  category: 'socket',
  description: 'Cambia el banner del menú. Usa setbanner <url> o cita una imagen o vídeo.',
  isOwner: true,
  run: async ({ msg, args = [], usedPrefix }) => {
    try {
      const settings = getBotSettings()
      const value = args.join(' ').trim()

      if (value) {
        if (!/^https?:\/\//i.test(value)) {
          return msg.reply(`❎ El banner debe ser una URL que empiece con http:// o https://.\nEjemplo: *${usedPrefix}setbanner* https://ejemplo.com/banner.jpg\n\nTambién puedes citar una imagen o un vídeo con *${usedPrefix}setbanner* sin texto.`)
        }
        updateBotSettings({ banner: value })
        return msg.reply(`✅ Se actualizó el banner de *${settings.name || 'RemBot-MD'}*.`)
      }

      const quoted = msg.quoted || msg
      const mime = mimeOf(quoted)
      if (!IMAGE_MIME.test(mime) && !VIDEO_MIME.test(mime)) {
        return msg.reply(`❎ Cita una imagen (PNG, JPG, GIF o WebP) o un vídeo MP4 para cambiar el banner.\nEjemplo: cita la imagen y escribe *${usedPrefix}setbanner*`)
      }
      const media = await downloadMedia(quoted)
      if (!media || !Buffer.isBuffer(media) || media.length === 0) {
        return msg.reply('❎ No se pudo descargar la imagen o el vídeo. Inténtalo de nuevo.')
      }
      const ext = extensionFor(mime)
      const fileName = `rem-banner.${ext}`
      await fs.mkdir(ASSETS_DIR, { recursive: true })
      await fs.writeFile(path.join(ASSETS_DIR, fileName), media)
      updateBotSettings({ banner: `assets/${fileName}` })
      return msg.reply(`✅ Se actualizó el banner de *${settings.name || 'RemBot-MD'}* (guardado en assets/${fileName}).`)
    } catch (error) {
      console.error('[setbanner] error:', error?.stack || error)
      await msg.reply('❎ No pude cambiar el banner. Inténtalo de nuevo.')
    }
  },
}
