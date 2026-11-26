// gdrive.js — Descargar un archivo de Google Drive.
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs externas: descarga directa con varios
// fallbacks (uc + página de confirmación de virus, usercontent, página
// del archivo). El endpoint POST antiguo de Drive ya no devuelve JSON,
// por eso el comando fallaba diciendo que el archivo no era público
// aunque sí lo fuera.
//
// Fallos que se detectan por separado:
// - Archivo no público / necesita permiso (pide iniciar sesión o
//   "Solicitar acceso").
// - Cuota de descargas superada ("Too many users have viewed...").
// - Archivo de Google Docs/Sheets/Slides (no es binario; no se puede
//   bajar por uc, necesita exportar).
// - Archivo muy grande para WhatsApp (límite de WhatsApp para documentos: 2 GB).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const MAX_SIZE = 2 * 1024 * 1024 * 1024 // 2 GB: máximo que WhatsApp acepta por documento

// Extrae el ID del archivo de cualquier forma de enlace de Drive.
// OJO: la versión anterior usaba /id=(.+)/ y se tragaba "&usp=sharing",
// por eso Drive respondía que el archivo no existía / no era público.
function extractId(input) {
  const url = String(input || '').trim()
  if (!url) return null
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    const byPath = parsed.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/)
    if (byPath?.[1]) return byPath[1]
    const byQuery = parsed.searchParams.get('id')
    if (byQuery && /^[a-zA-Z0-9_-]+$/.test(byQuery)) return byQuery
  } catch {}
  const loose = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  return loose?.[1] || null
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function parseFileSize(text) {
  if (!text) return null
  const raw = String(text).trim()
  const match = raw.match(/([\d.,]+)\s*(bytes?|b|kb|kib|mb|mib|gb|gib)/i)
  if (!match) return null
  let valueText = match[1]
  if (valueText.includes(',') && valueText.includes('.')) valueText = valueText.replace(/,/g, '')
  else valueText = valueText.replace(',', '.')
  const value = Number(valueText)
  if (!Number.isFinite(value) || value <= 0) return null
  const mult = { b: 1, byte: 1, bytes: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 }
  return Math.round(value * (mult[match[2].toLowerCase()] || 1))
}

function formatBytes(bytes = 0) {
  if (!bytes || Number.isNaN(bytes)) return 'Desconocido'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = Number(bytes)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

// Nombre/tamaño desde la página de aviso ("Nombre (356M)").
function parseWarningPage(html) {
  const nameSize = html.match(/uc-name-size">[\s\S]{0,300}?>([^<]+)<\/a>\s*\(([^)]+)\)/)
  const name = nameSize?.[1] ? decodeHtmlEntities(nameSize[1].trim()) : null
  const size = nameSize?.[2] ? parseFileSize(nameSize[2]) : null
  // Formulario de descarga: action + inputs ocultos (id, export, confirm, uuid).
  const form = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i)
    || html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i)
  let confirmUrl = null
  if (form) {
    const action = decodeHtmlEntities(form[1])
    const inputs = [...form[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)]
    const params = new URLSearchParams()
    for (const [, name, value] of inputs) params.set(name, decodeHtmlEntities(value))
    if (params.get('id')) {
      const base = action.startsWith('http') ? action : `https://drive.google.com${action}`
      confirmUrl = `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`
    }
  }
  return { name, size, confirmUrl }
}

function detectDriveError(html) {
  const text = String(html || '')
  if (/Too many users have viewed or downloaded this file/i.test(text)) {
    return 'Se superó la cuota de descargas de ese archivo. Inténtalo más tarde.'
  }
  if (/Request access|Solicitar acceso|You need access|Necesitas acceso/i.test(text)) {
    return 'Ese archivo no es público o no permite descargarlo con el enlace. Revisa que esté compartido como "Cualquier persona con el enlace".'
  }
  if (/Sign in - Google Accounts|Inicia sesión/i.test(text) && /drive\.google\.com/i.test(text)) {
    return 'Drive pide iniciar sesión para ese archivo: no es público.'
  }
  if (/Google Docs|Google Sheets|Google Slides/i.test(text) && /export/i.test(text)) {
    return 'Ese es un documento de Google (Docs/Sheets/Slides), no un archivo para descargar.'
  }
  return null
}

async function fetchBuffer(url, maxSize) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' })
  const contentType = res.headers.get('content-type') || ''
  const contentLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxSize) {
    throw new Error(`El archivo pesa ${formatBytes(contentLength)} y supera el límite de WhatsApp para documentos (2 GB).`)
  }
  if (!res.ok) throw new Error(`Drive respondió HTTP ${res.status}.`)
  if (contentType.includes('text/html')) {
    const html = await res.text()
    const problem = detectDriveError(html)
    if (problem) throw new Error(problem)
    return { html, res }
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length) throw new Error('Drive devolvió el archivo vacío.')
  if (buffer.length > maxSize) throw new Error(`El archivo pesa ${formatBytes(buffer.length)} y supera el límite de WhatsApp para documentos (2 GB).`)
  return { buffer, res }
}

function filenameFromHeaders(res, fallback) {
  const cd = res.headers.get('content-disposition') || ''
  const match = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i)
  const name = match?.[1] || match?.[2]
  if (name) {
    try { return decodeURIComponent(name) } catch { return name }
  }
  return fallback || 'archivo'
}

async function gdriveDownload(url) {
  const id = extractId(url)
  if (!id) throw new Error('No encontré el ID del archivo en ese enlace.')
  const directUrl = `https://drive.google.com/uc?export=download&id=${id}`
  const errors = []

  // Intento 1: descarga directa (archivos pequeños van directo).
  try {
    const first = await fetchBuffer(directUrl, MAX_SIZE)
    if (first.buffer) {
      return {
        buffer: first.buffer,
        fileName: filenameFromHeaders(first.res, null),
        mimetype: first.res.headers.get('content-type') || 'application/octet-stream',
        fileSize: first.buffer.length,
      }
    }
    // Página HTML: aviso de virus (archivo grande) u otro.
    const { name, size, confirmUrl } = parseWarningPage(first.html)
    if (confirmUrl) {
      const second = await fetchBuffer(confirmUrl, MAX_SIZE)
      if (second.buffer) {
        return {
          buffer: second.buffer,
          fileName: filenameFromHeaders(second.res, name),
          mimetype: second.res.headers.get('content-type') || 'application/octet-stream',
          fileSize: second.buffer.length,
        }
      }
      if (second.html) {
        const problem = detectDriveError(second.html)
        if (problem) throw new Error(problem)
      }
    }
    if (size && size > MAX_SIZE) {
      throw new Error(`El archivo pesa ${formatBytes(size)} y supera el límite de WhatsApp para documentos (2 GB).`)
    }
    const problem = detectDriveError(first.html)
    if (problem) throw new Error(problem)
    errors.push('la descarga directa devolvió una página sin enlace de descarga')
  } catch (error) {
    errors.push(`directa: ${error.message}`)
    if (/no es público|cuota|Documentos de Google|pesa/i.test(error.message)) throw error
  }

  // Intento 2: usercontent directo (nuevo dominio de descarga de Drive).
  try {
    const second = await fetchBuffer(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, MAX_SIZE)
    if (second.buffer) {
      return {
        buffer: second.buffer,
        fileName: filenameFromHeaders(second.res, null),
        mimetype: second.res.headers.get('content-type') || 'application/octet-stream',
        fileSize: second.buffer.length,
      }
    }
    const problem = detectDriveError(second.html)
    if (problem) throw new Error(problem)
    errors.push('usercontent devolvió una página sin archivo')
  } catch (error) {
    errors.push(`usercontent: ${error.message}`)
    if (/no es público|cuota|pesa/i.test(error.message)) throw error
  }

  // Intento 3: página del archivo (nombre real + enlace de descarga).
  try {
    const res = await fetch(`https://drive.google.com/file/d/${id}/view`, { headers: { 'user-agent': UA }, redirect: 'follow' })
    const html = await res.text()
    const problem = detectDriveError(html)
    if (problem) throw new Error(problem)
    const title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1]
      || html.match(/<title>([^<]+) - Google Drive<\/title>/i)?.[1]
    const { confirmUrl } = parseWarningPage(html)
    if (confirmUrl) {
      const third = await fetchBuffer(confirmUrl, MAX_SIZE)
      if (third.buffer) {
        return {
          buffer: third.buffer,
          fileName: filenameFromHeaders(third.res, title ? decodeHtmlEntities(title) : null),
          mimetype: third.res.headers.get('content-type') || 'application/octet-stream',
          fileSize: third.buffer.length,
        }
      }
    }
    errors.push('la página del archivo no trae enlace de descarga')
  } catch (error) {
    errors.push(`página: ${error.message}`)
    if (/no es público|cuota|pesa/i.test(error.message)) throw error
  }

  throw new Error(`No pude descargar ese archivo de Drive (${errors.join(' | ')}). Revisa que el enlace sea público.`)
}

export default {
  command: ['drive', 'gdrive'],
  category: 'downloads',
  description: 'Descarga un archivo de Google Drive. Uso: `gdrive <enlace de Drive>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args[0]) {
      return msg.reply(`*「✦」 𝗚𝗢𝗢𝗚𝗟𝗘 𝗗𝗥𝗜𝗩𝗘*\n> ✐ ᴜsᴏ » *${usedPrefix}gdrive <enlace de Google Drive>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}gdrive https://drive.google.com/file/d/ABC123/view_`)
    }
    const url = args[0]
    if (!/drive\.google\.com\/(file\/d\/|open\?id=|uc\?id=)|drive\.usercontent\.google\.com\/download/i.test(url)) {
      return msg.reply('*「✦」 𝗚𝗢𝗢𝗚𝗟𝗘 𝗗𝗥𝗜𝗩𝗘*\n> ✖ ᴇʀʀᴏʀ » *Ese enlace no parece de Google Drive. Revisa que sea un archivo compartido.*')
    }
    try {
      const { buffer, fileName, fileSize, mimetype } = await gdriveDownload(url)
      const caption = `*「✦」 𝗚𝗢𝗢𝗚𝗟𝗘 𝗗𝗥𝗜𝗩𝗘*\n> ❀ ɴᴏᴍʙʀᴇ » *${fileName}*\n> ❒ ᴛᴀᴍᴀñᴏ » *${formatBytes(fileSize)}*\n> ✰ ᴛɪᴘᴏ » *${mimetype}*\n> 🜸 ʟɪɴᴋ » _${url}_`
      await sock.sendMessage(msg.chat, { document: buffer, mimetype, fileName, caption }, { quoted: msg })
    } catch (error) {
      console.error('[gdrive] error:', error?.stack || error)
      await msg.reply(`*「✦」 𝗚𝗢𝗢𝗚𝗟𝗘 𝗗𝗥𝗜𝗩𝗘*\n> ✖ ᴇʀʀᴏʀ » *${error?.message || 'No pude descargar ese archivo de Drive. Inténtalo más tarde.'}*`)
    }
  },
}
