// facebook.js — Descargar un video de Facebook (reel o video).
// Autor: Jhon 𝗖𝗜𝗗. Sin APIs externas: extrae el video directo de la página.
// Nota: Facebook cambia su HTML con frecuencia; si deja de funcionar, el
// comando avisa y no se cae el bot.

const RE_URL = /(?:https?:\/\/)?(?:www\.|m\.|web\.|l\.)?facebook\.com\/[^\s<>"']+|fb\.watch\/[^\s<>"']+/i
const RE_ID = /\/reel\/(\d+)|[?&]v=(\d+)|\/videos\/(\d+)/
const RE_SHORT = /\/share\/(?:v|r|p)\/|fb\.watch\//

const HDR = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
}

// Petición HTTP con tiempo límite. Devuelve { status, url, body }.
async function fbFetch(url, { headers = {}, timeout = 45000, binary = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { ...HDR, ...headers }, signal: controller.signal })
    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text()
    return { status: res.status, url: res.url, body }
  } finally {
    clearTimeout(timer)
  }
}

const reelPage = id => `https://www.facebook.com/reel/${id}`
const reelId = u => (String(u).match(RE_ID) || []).slice(1).find(Boolean)

const unesc = s => String(s || '')
  .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\\//g, '/')

const decodeHtml = s => String(s || '')
  .replace(/&amp;/g, '&')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .trim()

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[^\d.,KMB]/gi, '').replace(',', '.'))
  if (Number.isNaN(n)) return null
  const u = String(v).toUpperCase()
  if (/K|MIL/.test(u)) return Math.round(n * 1e3)
  if (/M/.test(u)) return Math.round(n * 1e6)
  return Math.round(n)
}

const fromTitle = (t, k) => parseNum(t?.match(new RegExp(`([\\d.,]+)\\s*(mil|k|m)?\\s*${k}`, 'i'))?.[0])
const beforePost = (h, pid, re) => h.match(new RegExp(`${re.source}[\\s\\S]{0,8000}?"post_id":"${pid}"`))?.[1]

function parseStats(h, id) {
  const ogT = h.match(/property="og:title" content="([^"]+)"/i)?.[1]
  const ogD = h.match(/property="og:description" content="([^"]+)"/i)?.[1]
  const pid = h.match(new RegExp(`"video":\\{"id":"${id}"[\\s\\S]{0,12000}?"post_id":"(\\d+)"`))?.[1]
    || h.match(/"post_id":"(\d+)"/)?.[1]
  const last = ogT?.split('|').pop()?.trim()
  const s = {
    reelId: id,
    url: reelPage(id),
    description: decodeHtml(ogD || (last && !/views|reproducciones|reactions|reacciones/i.test(last) ? last : null)),
    views: +(h.match(/"(?:play|video_view|view)_count":(\d+)/)?.[1] || '') || fromTitle(ogT, 'reproducciones|views?'),
    reactions: pid ? +(beforePost(h, pid, /"unified_reactors":\{"count":(\d+)/) || '') : null,
    comments: pid ? +(beforePost(h, pid, /"total_comment_count":(\d+)/) || '') : null,
    shares: pid ? parseNum(beforePost(h, pid, /"share_count_reduced":"([^"]+)"/)) : null,
    ownerId: h.match(new RegExp(`facebook\\.com/(\\d+)/videos/[^"']*${id}`))?.[1],
  }
  if (!s.reactions) s.reactions = fromTitle(ogT, 'reacciones|reactions?')
  if (!s.views) s.views = fromTitle(ogT, 'reproducciones|views?')
  return s
}

function parseVideo(h, id) {
  const c = h.includes(`"id":"${id}"`)
    ? h.slice(h.indexOf(`"id":"${id}"`), h.indexOf(`"id":"${id}"`) + 25e3)
    : h
  const m = re => (c.match(re) || h.match(re))?.[1]
  return decodeHtml(unesc(
    m(/"browser_native_hd_url":"((?:\\.|[^"\\])+)"/) ||
    m(/"browser_native_sd_url":"((?:\\.|[^"\\])+)"/) ||
    '',
  ))
}

async function getReel(text) {
  const raw = String(text || '').trim()
  const link = (raw.match(RE_URL)?.[0] || raw.split(/\s+/)[0])?.replace(/[.,;:!?)]+$/g, '')
  if (!link) return null
  const source = link.startsWith('http') ? link : `https://${link}`
  let id = reelId(source)
  let html
  let lastError
  if (!id && RE_SHORT.test(source)) {
    try {
      const r = await fbFetch(source)
      id = reelId(r.url) || r.body.match(/\/reel\/(\d+)/)?.[1]
      html = r.body
    } catch (e) { lastError = e }
    if (!id) return null
  }
  if (!id) return null
  const url = reelPage(id)
  const pages = [...new Set([
    source, url,
    `https://m.facebook.com/reel/${id}`,
    `https://web.facebook.com/reel/${id}`,
    `https://www.facebook.com/watch/?v=${id}`,
    `https://m.facebook.com/watch/?v=${id}`,
  ])]
  if (!html || !parseVideo(html, id)) {
    html = null
    for (const page of pages) {
      try {
        const r = await fbFetch(page)
        if (/login|two_step_verification/i.test(r.url)) {
          lastError = new Error('El reel es privado o pide iniciar sesión en Facebook.')
          continue
        }
        if (r.body && (r.status === 200 || r.body.includes(`"id":"${id}"`) || r.body.includes('browser_native_hd_url') || r.body.includes('browser_native_sd_url'))) {
          html = r.body
          break
        }
        lastError = new Error(`Facebook respondió HTTP ${r.status}.`)
      } catch (e) { lastError = e }
    }
  }
  if (!html) throw lastError || new Error('No se pudo abrir el reel.')
  const stats = parseStats(html, id)
  stats.sourceUrl = source !== url ? source : undefined
  stats.videoUrl = parseVideo(html, id)
  return stats
}

async function getFacebookMedia(url) {
  const target = await getReel(url)
  if (!target?.videoUrl) return null
  return {
    type: 'video',
    title: decodeHtml(target.description || 'Video de Facebook'),
    resolution: 'HD',
    format: 'mp4',
    url: target.videoUrl,
    thumbnail: null,
    duration: null,
  }
}

export default {
  command: ['fb', 'facebook'],
  category: 'downloads',
  description: 'Descarga un video o reel de Facebook. Uso: `fb <enlace de Facebook>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    if (!args[0]) {
      return msg.reply(`Pega un enlace de Facebook.\nEjemplo: *${usedPrefix}fb https://www.facebook.com/reel/123456789*`)
    }
    if (!/facebook\.com|fb\.watch|video\.fb\.com/i.test(args[0])) {
      return msg.reply('Ese enlace no parece de Facebook. Revisa que sea un video o reel válido.')
    }
    try {
      const data = await getFacebookMedia(args[0])
      if (!data) return msg.reply('No pude obtener ese video. Puede ser privado o el enlace no tiene video.')
      const caption = `*Facebook*\n\n${data.title ? `*Título:* ${data.title}\n` : ''}${data.resolution ? `*Resolución:* ${data.resolution}\n` : ''}${data.format ? `*Formato:* ${data.format}\n` : ''}*Enlace:* ${args[0]}`
      await sock.sendMessage(msg.chat, { video: { url: data.url }, caption, mimetype: 'video/mp4', fileName: 'fb.mp4' }, { quoted: msg })
    } catch (error) {
      console.error('[facebook] error:', error?.stack || error)
      await msg.reply(error?.message || 'No pude descargar ese video de Facebook. Inténtalo más tarde.')
    }
  },
}
