// mediafire.js — Descargar un archivo de MediaFire.
// Autor: Jhon 𝗖𝗜𝗗. Extrae el enlace directo de la página (scraping,
// sin API). Varios fallbacks porque MediaFire a veces no responde desde
// el servidor: 1) axios + cheerio (#downloadButton), 2) fetch + regex
// del enlace download*.mediafire.com en el HTML, 3) reintento con otro
// User-Agent. Si la página es un reto anti-bot o el archivo se eliminó,
// lo dice claro en vez de quedarse callado.
// Sin mime-types: el tipo se resuelve con una tabla local extensión → MIME.

import axios from 'axios'
import path from 'node:path'
import * as cheerio from 'cheerio'

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const UA_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'

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

// Límite: 2 GB (máximo que WhatsApp acepta por documento). Sin este
// tope, Baileys intenta subir archivos enormes y falla con ENOSPC
// porque escribe varias copias temporales al enviar.
const MAX_SIZE = 2 * 1024 * 1024 * 1024

function parseSize(text) {
  if (!text) return null
  const match = String(text).trim().match(/([\d.,]+)\s*(bytes?|b|kb|kib|mb|mib|gb|gib)/i)
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

function cleanText(x) {
  return String(x || '').replace(/\s+/g, ' ').trim()
}

function normalizeUrl(u) {
  const s = cleanText(u)
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return 'https:' + s
  if (s.startsWith('/')) return 'https://www.mediafire.com' + s
  return s
}

function pickFilename($) {
  return cleanText($('.intro .filename').text())
    || cleanText($('meta[property="og:title"]').attr('content'))
    || cleanText($('title').text())
    || null
}

function pickDetails($) {
  let size = null
  let uploaded = null
  $('ul.details li').each((_, el) => {
    const text = cleanText($(el).text())
    if (!size && /File size:/i.test(text)) size = cleanText($(el).find('span').text()) || null
    if (!uploaded && /Uploaded:/i.test(text)) uploaded = cleanText($(el).find('span').text()) || null
  })
  return { size, uploaded }
}

function detectPageProblem(html, status) {
  const text = String(html || '')
  if (status === 404) return 'Ese enlace no existe o el archivo fue eliminado de MediaFire.'
  if (/File Removed for Violation|This file has been removed|archivo ha sido eliminado/i.test(text)) {
    return 'Ese archivo fue eliminado de MediaFire.'
  }
  if (/cf-challenge|Just a moment|Attention Required|are you a robot|Verifying you are human/i.test(text)) {
    return 'MediaFire puso un reto anti-bot y no dejó leer la página desde el servidor. Reintenta en unos minutos.'
  }
  return null
}

// Busca el enlace directo en el HTML sin depender del botón.
function findDownloadInHtml(html) {
  const matches = String(html || '').match(/https:\/\/download\d+\.mediafire\.com\/[^"'\\\s<>]+/gi)
  if (matches?.length) return normalizeUrl(matches[0])
  const quoted = String(html || '').match(/"(https?:\/\/download[^"]*\.mediafire\.com[^"]*)"/i)
  if (quoted?.[1]) return normalizeUrl(quoted[1])
  return null
}

function parsePage(html) {
  const $ = cheerio.load(String(html || ''))
  const downloadLink = normalizeUrl($('#downloadButton').attr('href') || $('a#downloadButton').attr('href') || null)
    || normalizeUrl($('a[href*="download"][href*="mediafire.com"]').first().attr('href') || null)
    || findDownloadInHtml(html)
  const filename = pickFilename($)
  const filetype = cleanText($('.filetype').text()) || null
  const { size, uploaded } = pickDetails($)
  return { downloadLink, filename, filetype, size, uploaded }
}

async function mediafireDl(url, timeout = 45000) {
  const mediafireUrl = cleanText(url)
  if (!mediafireUrl) throw new Error('Falta la URL.')
  const errors = []

  // Intento 1: axios + cheerio (botón de descarga).
  try {
    const res = await axios.get(mediafireUrl, {
      timeout,
      maxRedirects: 5,
      headers: { 'User-Agent': UA_CHROME, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      validateStatus: () => true,
    })
    const problem = detectPageProblem(res.data, res.status)
    if (problem) throw new Error(problem)
    if (res.status < 200 || res.status >= 400) throw new Error(`MediaFire respondió HTTP ${res.status}.`)
    const parsed = parsePage(String(res.data || ''))
    if (parsed.downloadLink) return parsed
    errors.push('el botón de descarga no apareció en la página')
  } catch (error) {
    errors.push(`axios: ${error.message}`)
    if (/eliminado|anti-bot|no existe/i.test(error.message)) throw error
  }

  // Intento 2: fetch con otro User-Agent + regex del enlace directo.
  try {
    const res = await fetch(mediafireUrl, {
      headers: { 'User-Agent': UA_FIREFOX, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    })
    const html = await res.text()
    const problem = detectPageProblem(html, res.status)
    if (problem) throw new Error(problem)
    if (!res.ok) throw new Error(`MediaFire respondió HTTP ${res.status}.`)
    const parsed = parsePage(html)
    if (parsed.downloadLink) return parsed
    errors.push('fetch: la página no trae enlace directo')
  } catch (error) {
    errors.push(`fetch: ${error.message}`)
    if (/eliminado|anti-bot|no existe/i.test(error.message)) throw error
  }

  // Intento 3: reintento del primero (bloqueos transitorios del servidor).
  try {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const res = await axios.get(mediafireUrl, {
      timeout,
      maxRedirects: 5,
      headers: { 'User-Agent': UA_FIREFOX, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      validateStatus: () => true,
    })
    if (res.status >= 200 && res.status < 400) {
      const parsed = parsePage(String(res.data || ''))
      if (parsed.downloadLink) return parsed
    }
    errors.push('reintento: sin enlace directo')
  } catch (error) {
    errors.push(`reintento: ${error.message}`)
  }

  throw new Error(`MediaFire no respondió con el enlace (${errors.join(' | ')}). Puede que el servidor esté bloqueado por MediaFire: reintenta más tarde.`)
}

export default {
  command: ['mediafire', 'mf'],
  category: 'downloads',
  description: 'Descarga un archivo de MediaFire. Uso: `mf <enlace de MediaFire>.',
  run: async ({ msg, sock, args, usedPrefix, text }) => {
    const url = (text || '').trim()
    if (!url) {
      return msg.reply(`Pega un enlace de MediaFire.\nEjemplo: *${usedPrefix}mf https://www.mediafire.com/file/abc123/archivo.zip*`)
    }
    if (!/^https?:\/\/(www\.)?mediafire\.com\/.+/i.test(url)) {
      return msg.reply('Ese enlace no parece de MediaFire. Revisa que sea un archivo compartido.')
    }
    try {
      const scraped = await mediafireDl(url)
      if (!scraped?.downloadLink) return msg.reply('No pude obtener ese archivo.')
      const sizeBytes = parseSize(scraped.size)
      if (sizeBytes && sizeBytes > MAX_SIZE) {
        return msg.reply(`Ese archivo pesa ${formatBytes(sizeBytes)} y supera el límite de WhatsApp para documentos (2 GB).`)
      }
      const title = (scraped.filename || 'archivo').trim()
      const ext = path.extname(title) || (scraped.type ? `.${scraped.type}` : '')
      const tipo = mimeFor(ext)
      let info = '*MediaFire*\n\n'
      info += `*Nombre:* ${title}\n`
      info += `*Tipo:* ${tipo}\n`
      if (scraped.size) info += `*Peso:* ${scraped.size}\n`
      if (scraped.uploaded) info += `*Subido:* ${scraped.uploaded}\n`
      await sock.sendMessage(msg.chat, {
        document: { url: scraped.downloadLink },
        mimetype: tipo,
        fileName: title,
        caption: info,
        mentions: [msg.sender],
      }, { quoted: msg })
    } catch (error) {
      console.error('[mediafire] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar ese archivo de MediaFire. Inténtalo más tarde.')
    }
  },
}
