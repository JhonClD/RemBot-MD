// mega.js — Descargar un archivo de MEGA.
// Autor: Jhon 𝗖𝗜𝗗. Enlaces públicos con su clave en la URL
// (file/<id>#<clave>). Sin API key ni cuenta: usa megajs.
// Las carpetas no se pueden descargar (solo archivos sueltos).
// Límite: 2 GB (máximo que WhatsApp acepta por documento).

import { File } from 'megajs'
import path from 'node:path'

const MAX_SIZE = 2 * 1024 * 1024 * 1024 // 2 GB: máximo de WhatsApp para documentos
const MEGA_HOST = ['mega', 'nz'].join('.')

const EXT_MIME = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.opus': 'audio/opus', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.apk': 'application/vnd.android.package-archive',
  '.txt': 'text/plain', '.srt': 'text/plain', '.ass': 'text/plain',
  '.epub': 'application/epub+zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function mimeFor(ext) {
  return EXT_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream'
}

function formatBytes(bytes = 0) {
  if (!bytes || Number.isNaN(bytes)) return 'Desconocido'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = Number(bytes)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

function exampleLink() {
  return `https://${MEGA_HOST}/file/AbCdEfGh#IjKlMnOpQrStUvWxYz`
}

async function megaDownload(url) {
  let file
  try {
    file = File.fromURL(url)
  } catch {
    throw new Error('Ese enlace de MEGA no es válido. Usa uno con este formato: ' + exampleLink())
  }
  if (!file) throw new Error('Ese enlace de MEGA no es válido.')
  if (file.directory) {
    throw new Error('Ese enlace es una carpeta de MEGA. Solo puedo descargar archivos sueltos (file/...).')
  }
  if (!file.key) {
    throw new Error('El enlace no trae la clave de descifrado (#...). Pega el enlace completo de MEGA.')
  }
  try {
    await file.loadAttributes()
  } catch (error) {
    const message = String(error?.message || error)
    if (/not found|no longer available|ENOENT/i.test(message)) {
      throw new Error('Ese archivo de MEGA ya no existe o el enlace es inválido.')
    }
    throw new Error(`MEGA respondió: ${message}`)
  }
  const name = file.name || 'archivo'
  const size = Number(file.size) || 0
  if (size > MAX_SIZE) {
    throw new Error(`El archivo pesa ${formatBytes(size)} y supera el límite de WhatsApp para documentos (2 GB).`)
  }
  let buffer
  try {
    buffer = await file.downloadBuffer()
  } catch (error) {
    const message = String(error?.message || error)
    if (/key isn't defined/i.test(message)) {
      throw new Error('El enlace no trae la clave de descifrado (#...). Pega el enlace completo de MEGA.')
    }
    throw new Error(`No pude bajar el archivo de MEGA: ${message}`)
  }
  if (!buffer?.length) throw new Error('MEGA devolvió el archivo vacío.')
  if (buffer.length > MAX_SIZE) {
    throw new Error(`El archivo pesa ${formatBytes(buffer.length)} y supera el límite de WhatsApp para documentos (2 GB).`)
  }
  return { buffer, name, size: buffer.length }
}

export default {
  command: ['mega'],
  category: 'downloads',
  description: 'Descarga un archivo de MEGA. Uso: `mega <enlace de MEGA>.',
  run: async ({ msg, sock, args, usedPrefix, text }) => {
    const url = (text || '').trim()
    if (!url) {
      return msg.reply(`Pega un enlace de MEGA.\nEjemplo: *${usedPrefix}mega ${exampleLink()}*`)
    }
    if (!new RegExp(`^https?://(www\\.)?${MEGA_HOST.replace('.', '\\.')}/(file/|folder/|#![^!]+!)`, 'i').test(url)) {
      return msg.reply('Ese enlace no parece de MEGA. Tiene que ser un archivo público: ' + exampleLink())
    }
    try {
      const { buffer, name, size } = await megaDownload(url)
      const ext = path.extname(name)
      const caption = `*MEGA*\n\n*Nombre:* ${name}\n*Tamaño:* ${formatBytes(size)}\n*Tipo:* ${mimeFor(ext)}\n\n*Enlace:* ${url}`
      await sock.sendMessage(msg.chat, { document: buffer, mimetype: mimeFor(ext), fileName: name, caption }, { quoted: msg })
    } catch (error) {
      console.error('[mega] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar ese archivo de MEGA. Inténtalo más tarde.')
    }
  },
}
