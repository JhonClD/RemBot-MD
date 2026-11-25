// gdrive.js — Descargar un archivo de Google Drive.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs externas: usa el enlace de descarga de Drive.
// Nota: si el archivo supera la cuota de descargas del enlace, Drive no
// devuelve el archivo y el comando avisa.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3325.181 Safari/537.36'

// Extrae el ID del archivo de un enlace de Drive.
function extractId(url) {
  return (String(url).match(/\/?id=(.+)/i) || String(url).match(/\/d\/(.*?)\//))?.[1] || null
}

// Devuelve { status, data } o { status: false, message }.
async function gdriveScraper(url) {
  try {
    const id = extractId(url)
    if (!id) throw new Error('No encontré el ID del archivo en ese enlace.')
    const res = await fetch(`https://drive.google.com/uc?id=${id}&authuser=0&export=download`, {
      method: 'POST',
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        'content-length': 0,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        origin: 'https://drive.google.com',
        'user-agent': UA,
        'x-drive-first-party': 'DriveWebUi',
        'x-json-requested': 'true',
      },
    })
    const { fileName, sizeBytes, downloadUrl } = JSON.parse((await res.text()).slice(4))
    if (!downloadUrl) throw new Error('Se superó el número de descargas de ese enlace.')
    const data = await fetch(downloadUrl)
    if (data.status !== 200) throw new Error(`Drive respondió HTTP ${data.status}.`)
    return {
      status: true,
      data: {
        downloadUrl,
        fileName,
        fileSize: `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`,
        mimetype: data.headers.get('content-type') || 'application/octet-stream',
      },
    }
  } catch (error) {
    return { status: false, message: error.message }
  }
}

export default {
  command: ['drive', 'gdrive'],
  category: 'downloads',
  description: 'Descarga un archivo de Google Drive. Uso: `gdrive <enlace de Drive>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args[0]) {
      return msg.reply(`Pega un enlace de Google Drive.\nEjemplo: *${usedPrefix}gdrive https://drive.google.com/file/d/ABC123/view*`)
    }
    const url = args[0]
    if (!/drive\.google\.com\/(file\/d\/|open\?id=|uc\?id=)/.test(url)) {
      return msg.reply('Ese enlace no parece de Google Drive. Revisa que sea un archivo compartido.')
    }
    try {
      const result = await gdriveScraper(url)
      if (!result.status) {
        return msg.reply(`No pude obtener ese archivo. ${result.message || 'Inténtalo con otro enlace.'}`)
      }
      const { fileName, fileSize, mimetype, downloadUrl } = result.data
      const caption = `*Google Drive*\n\n*Nombre:* ${fileName}\n*Tamaño:* ${fileSize}\n*Tipo:* ${mimetype}\n\n*Enlace:* ${url}`
      await sock.sendMessage(msg.chat, { document: { url: downloadUrl }, mimetype, fileName, caption }, { quoted: msg })
    } catch (error) {
      console.error('[gdrive] error:', error?.stack || error)
      await msg.reply('No pude descargar ese archivo de Drive. Inténtalo más tarde.')
    }
  },
}
