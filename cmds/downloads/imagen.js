// imagen.js — Buscar y descargar imágenes de Google (vía API pública Delirius).
// Autor: Jhon 𝗖𝗜𝗗.
// Nota: RemBot no tiene ajuste NSFW por grupo (el botstore no lo guarda), así
// que el filtro de términos +18 se aplica siempre, sin excepciones.

import axios from 'axios'

const DELIRIUS_URL = 'https://api.delirius.online'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

const BANNED_WORDS = ['+18', '18+', 'contenido adulto', 'contenido explícito', 'contenido sexual', 'actriz porno', 'actor porno', 'estrella porno', 'pornstar', 'video xxx', 'xxx', 'x x x', 'pornhub', 'xvideos', 'xnxx', 'redtube', 'brazzers', 'onlyfans', 'cam4', 'chaturbate', 'myfreecams', 'bongacams', 'livejasmin', 'spankbang', 'tnaflix', 'hclips', 'fapello', 'mia khalifa', 'lana rhoades', 'riley reid', 'abella danger', 'brandi love', 'eva elfie', 'nicole aniston', 'janice griffith', 'alexis texas', 'lela star', 'gianna michaels', 'adriana chechik', 'asa akira', 'mandy muse', 'kendra lust', 'jordi el niño polla', 'johnny sins', 'danny d', 'manuel ferrara', 'mark rockwell', 'porno', 'porn', 'sexo', 'sex', 'desnudo', 'desnuda', 'erótico', 'erotico', 'erotika', 'tetas', 'pechos', 'boobs', 'boob', 'nalgas', 'culo', 'culos', 'qlos', 'trasero', 'pene', 'verga', 'vergota', 'pito', 'chocha', 'vagina', 'vaginas', 'coño', 'concha', 'genital', 'genitales', 'masturbar', 'masturbación', 'masturbacion', 'gemidos', 'gemir', 'orgía', 'orgy', 'trío', 'trio', 'gangbang', 'creampie', 'facial', 'cum', 'milf', 'teen', 'incesto', 'incest', 'violación', 'violacion', 'rape', 'bdsm', 'hentai', 'tentacle', 'tentáculos', 'fetish', 'fetiche', 'sado', 'sadomaso', 'camgirl', 'camsex', 'camshow', 'playboy', 'playgirl', 'playmate', 'striptease', 'striptis', 'slut', 'puta', 'putas', 'perra', 'perras', 'whore', 'fuck', 'fucking', 'fucked', 'cock', 'dick', 'pussy', 'ass', 'shemale', 'trans', 'transgénero', 'transgenero', 'lesbian', 'lesbiana', 'gay', 'lgbt', 'explicit', 'hardcore', 'softcore', 'nudista', 'nudismo', 'nudity', 'deepthroat', 'dp', 'double penetration', 'analplay', 'analplug', 'rimjob', 'spank', 'spanking', 'lick', 'licking', '69', 'doggystyle', 'reverse cowgirl', 'cowgirl', 'blowjob', 'bj', 'handjob', 'hj', 'p0rn', 's3x', 'v@gina', 'c0ck', 'd1ck', 'fuk', 'fuking', 'fak', 'boobz', 'pusy', 'azz', 'cumshot', 'sexcam', 'livecam', 'webcam', 'sexchat', 'sexshow', 'sexvideo', 'sexvid', 'sexpics', 'sexphoto', 'seximage', 'sexgif', 'pornpic', 'pornimage', 'pornvid', 'pornvideo', 'only fan', 'only-fans', 'only_fans', 'onlyfans.com']

// Comprueba con un HEAD (y si falla, con un GET parcial) que la URL es una imagen.
async function isImageAccessible(url) {
  try {
    const response = await axios.head(url, { timeout: 5000, headers: { 'User-Agent': UA }, maxRedirects: 3, validateStatus: status => status < 400 })
    return (response.headers['content-type'] || '').startsWith('image/')
  } catch {
    try {
      await axios.get(url, { timeout: 5000, headers: { 'User-Agent': UA, Range: 'bytes=0-1023' }, maxRedirects: 3, responseType: 'arraybuffer', validateStatus: status => status < 400 || status === 206 })
      return true
    } catch {
      return false
    }
  }
}

async function filterValidImages(results) {
  const checks = await Promise.allSettled(results.map(async r => (await isImageAccessible(r.url)) ? r : null))
  return checks.filter(c => c.status === 'fulfilled' && c.value !== null).map(c => c.value)
}

async function getImageSearchResults(query) {
  try {
    const { data } = await axios.get(`${DELIRIUS_URL}/search/gimage?query=${encodeURIComponent(query)}`, { timeout: 30000 })
    if (!data?.status || !Array.isArray(data.data)) return []
    return data.data.map(item => ({
      url: item.url,
      title: item.origin?.title || null,
      domain: item.origin?.website?.domain || null,
      resolution: item.width && item.height ? `${item.width}x${item.height}` : null,
    }))
  } catch {
    return []
  }
}

// Envía el álbum; si el álbum falla (por ejemplo, solo queda 1 imagen),
// manda las imágenes una por una.
async function sendImages({ sock, chat, msg, medias }) {
  if (medias.length >= 2 && typeof sock.sendAlbumMessage === 'function') {
    try {
      await sock.sendAlbumMessage(chat, medias, { quoted: msg })
      return
    } catch (error) {
      console.error('[imagen] álbum falló, mando una por una:', error?.message || error)
    }
  }
  for (const media of medias) {
    await sock.sendMessage(chat, { image: media.data, caption: media.caption }, { quoted: msg })
  }
}

export default {
  command: ['imagen', 'img', 'image'],
  category: 'downloads',
  description: 'Busca imágenes en Google y las manda en álbum. Uso: `imagen <búsqueda>.',
  run: async ({ msg, sock, args, usedPrefix }) => {
    const text = args.join(' ').trim()
    if (!text) {
      return msg.reply(`*「✦」 𝗜𝗠𝗔𝗚𝗘𝗡*\n> ✐ ᴜsᴏ » *${usedPrefix}imagen <búsqueda>*\n> ❝ ᴇᴊᴇᴍᴘʟᴏ » _${usedPrefix}imagen gatitos_`)
    }
    const lowerText = text.toLowerCase()
    if (BANNED_WORDS.some(word => lowerText.includes(word))) {
      return msg.reply('*「✦」 𝗜𝗠𝗔𝗚𝗘𝗡*\n> ✖ ᴇʀʀᴏʀ » *Este comando no permite búsquedas de contenido +18 o NSFW.*')
    }
    try {
      const results = await getImageSearchResults(text)
      if (!results?.length) {
        return msg.reply(`*「✦」 𝗜𝗠𝗔𝗚𝗘𝗡*\n> ✖ ᴇʀʀᴏʀ » *No encontré imágenes para ${text}.*`)
      }
      const validResults = await filterValidImages(results.slice(0, 15))
      if (validResults.length < 2) {
        return msg.reply('*「✦」 𝗜𝗠𝗔𝗚𝗘𝗡*\n> ✖ ᴇʀʀᴏʀ » *No encontré suficientes imágenes válidas para mostrar el álbum.*')
      }
      const medias = validResults.slice(0, 10).map(r => ({
        type: 'image',
        data: { url: r.url },
        caption: `*「✦」 𝗜𝗠𝗔𝗚𝗘𝗡*${r.title ? `\n> ❀ ᴛíᴛᴜʟᴏ » *${r.title}*` : ''}${r.domain ? `\n> ✐ ғᴜᴇɴᴛᴇ » *${r.domain}*` : ''}${r.resolution ? `\n> ✰ ʀᴇsᴏʟᴜᴄɪóɴ » *${r.resolution}*` : ''}\n> ❝ ᴛᴇxᴛᴏ » *${text}*`,
      }))
      await sendImages({ sock, chat: msg.chat, msg, medias })
    } catch (error) {
      console.error('[imagen] error:', error?.stack || error)
      await msg.reply('*「✦」 𝗜𝗠𝗔𝗚𝗘𝗡*\n> ✖ ᴇʀʀᴏʀ » *No pude buscar imágenes ahora. Inténtalo más tarde.*')
    }
  },
}
