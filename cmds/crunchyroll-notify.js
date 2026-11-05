import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TMP_DIR = path.resolve('lib/system/tmp/cr-notify')
const DB_PATH = path.join(TMP_DIR, 'crunchyroll-seen.json')
const CFG_PATH = path.join(TMP_DIR, 'crunchyroll-cfg.json')
const MAX_SEEN = 500

const CR_BASE = 'https://www.crunchyroll.com'
const CR_BETA = 'https://beta-api.crunchyroll.com'
const CR_AUTH = `${CR_BASE}/auth/v1/token`
const CR_RSS = 'https://feeds.feedburner.com/crunchyroll/rss/anime'
const CREDENTIALS_URL = 'https://raw.githubusercontent.com/vitalygashkov/crextractor/refs/heads/main/credentials.tv.json'
const BASIC_ANON_FALLBACK = 'Basic bmR0aTZicXlqcm9wNXZnZjF0dnU6elpIcS00SEJJVDlDb2FMcnBPREJjRVRCTUNHai1QNlg='
const BASIC_AUTH_FALLBACK = 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZWdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA_FALLBACK = 'Crunchyroll/ANDROIDTV/3.76.0_22366 (Android 16; en-US; sdk_gphone64_x86_64)'

const SEND_JID_DELAY_MS = envNum('CR_SEND_JID_DELAY_MS', 1500)
const SEND_DELAY_MS = envNum('CR_SEND_DELAY_MS', 1000)
const BROWSE_TIMEOUT_MS = envNum('CR_BROWSE_TIMEOUT_MS', 20000, 1000)
const HEALTH_INTERVAL_MS = 30 * 60_000
const CREDENTIAL_CACHE_MS = 6 * 60 * 60_000
const CREDENTIAL_RETRY_MS = 15 * 60_000
const COOKIE_TTL_MS = 6 * 60 * 60_000

fs.mkdirSync(TMP_DIR, { recursive: true })
try { fs.chmodSync(TMP_DIR, 0o700) } catch {}
for (const file of [DB_PATH, CFG_PATH]) {
  if (fs.existsSync(file)) {
    try { fs.chmodSync(file, 0o600) } catch {}
  }
}

const runtime = globalThis.__rembotCrunchyrollNotify ??= {
  cronTimer: null,
  healthTimer: null,
  cronRunning: false,
  storedSock: null,
  deviceId: null,
  anonId: crypto.randomUUID(),
  token: null,
  tokenExp: 0,
  cookies: '',
  cookiesExp: 0,
  basicAnon: BASIC_ANON_FALLBACK,
  basicAuth: BASIC_AUTH_FALLBACK,
  userAgent: CR_UA_FALLBACK,
  credentialCache: { exp: 0, source: 'fallback', lastError: null },
  credentialRefresh: null,
  lock: Promise.resolve(),
}

function envNum(name, fallback, min = 0) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function atomicWrite(file, value) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  try { fs.chmodSync(temp, 0o600) } catch {}
  fs.renameSync(temp, file)
}

function loadJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function loadCfg() {
  const cfg = loadJson(CFG_PATH, {})
  if (cfg.targetJid && !cfg.targetJids) {
    cfg.targetJids = [cfg.targetJid]
    delete cfg.targetJid
    saveCfg(cfg)
  }
  cfg.targetJids = [...new Set((Array.isArray(cfg.targetJids) ? cfg.targetJids : []).filter((jid) => typeof jid === 'string' && jid.trim()))]
  return cfg
}

function saveCfg(cfg) {
  atomicWrite(CFG_PATH, cfg)
}

function loadSeen() {
  const seen = loadJson(DB_PATH, [])
  return Array.isArray(seen) ? [...new Set(seen.filter((id) => typeof id === 'string' && id))] : []
}

function saveSeen(ids) {
  atomicWrite(DB_PATH, [...new Set(ids)].slice(-MAX_SEEN))
}

function isValidBasic(value) {
  if (typeof value !== 'string' || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 512) return false
  try {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    return separator > 0 && separator < decoded.length - 1 && !/[\u0000-\u001f\u007f]/.test(decoded)
  } catch {
    return false
  }
}

function parseClientVersion(value) {
  if (typeof value !== 'string' || value.length > 48) return null
  const match = value.match(/^((?:\d+\.){1,3}\d+) \((\d{3,8})\)$/)
  return match ? { version: match[1], build: match[2] } : null
}

function buildBasic(clientId, clientSecret) {
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null
  if (!clientId || !clientSecret || clientId.length > 128 || clientSecret.length > 128) return null
  if (/[\u0000-\u001f\u007f]/.test(clientId + clientSecret)) return null
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  return isValidBasic(basic) ? basic : null
}

function applyCredentials(authorization, client, basicAuth) {
  runtime.basicAnon = authorization
  if (basicAuth) runtime.basicAuth = basicAuth
  runtime.userAgent = `Crunchyroll/ANDROIDTV/${client.version}_${client.build} (Android 16; en-US; sdk_gphone64_x86_64)`
}

async function fetchCredentials() {
  const response = await fetch(CREDENTIALS_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const raw = await response.text()
  if (raw.length > 32 * 1024) throw new Error('respuesta demasiado grande')
  const data = JSON.parse(raw)
  const client = parseClientVersion(data?.version)
  if (!isValidBasic(data?.authorization) || !client) throw new Error('credenciales remotas inválidas')
  return { authorization: data.authorization, client, basicAuth: buildBasic(data.client_id, data.client_secret) }
}

async function refreshCredentials() {
  if (runtime.credentialRefresh) return runtime.credentialRefresh
  if (runtime.credentialCache.exp && Date.now() < runtime.credentialCache.exp) return

  runtime.credentialRefresh = (async () => {
    try {
      const current = await fetchCredentials()
      applyCredentials(current.authorization, current.client, current.basicAuth)
      runtime.credentialCache = { exp: Date.now() + CREDENTIAL_CACHE_MS, source: 'crextractor', lastError: null }
      console.log(`[CR-Notify] Credenciales actualizadas (v${current.client.version}, build ${current.client.build}).`)
      return
    } catch (error) {
      runtime.credentialCache.lastError = `crextractor: ${error.message}`
      console.warn(`[CR-Notify] Credenciales remotas no disponibles: ${error.message}. Usando fallback.`)
      runtime.credentialCache = { exp: Date.now() + CREDENTIAL_RETRY_MS, source: 'fallback', lastError: runtime.credentialCache.lastError }
    }
  })().finally(() => { runtime.credentialRefresh = null })

  return runtime.credentialRefresh
}

async function preLogin(force = false) {
  if (!force && runtime.cookies && Date.now() < runtime.cookiesExp) return
  await refreshCredentials()
  try {
    const response = await fetch(CR_BASE, {
      headers: { 'User-Agent': runtime.userAgent },
      signal: AbortSignal.timeout(15000),
    })
    const cookies = response.headers.getSetCookie?.() || []
    runtime.cookies = cookies.map((cookie) => cookie.split(';')[0]).join('; ')
    runtime.cookiesExp = Date.now() + COOKIE_TTL_MS
  } catch {}
}

async function getAnonToken() {
  if (runtime.token && Date.now() < runtime.tokenExp - 30_000) return runtime.token
  await refreshCredentials()
  await preLogin()

  const response = await fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      Authorization: runtime.basicAnon,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': runtime.userAgent,
      'ETP-Anonymous-ID': runtime.anonId,
      Cookie: runtime.cookies,
    },
    body: new URLSearchParams({
      grant_type: 'client_id',
      scope: 'offline_access',
      device_id: getDeviceId(),
      device_type: 'ANDROIDTV',
    }).toString(),
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160)
    throw new Error(`Auth anónima HTTP ${response.status}: ${detail}`)
  }
  const data = await response.json()
  runtime.token = data.access_token
  runtime.tokenExp = Date.now() + (data.expires_in || 300) * 1000
  return runtime.token
}

function getDeviceId() {
  if (runtime.deviceId) return runtime.deviceId
  const cfg = loadCfg()
  runtime.deviceId = cfg.deviceId || crypto.randomUUID()
  if (!cfg.deviceId) {
    cfg.deviceId = runtime.deviceId
    saveCfg(cfg)
  }
  return runtime.deviceId
}

async function loginWithAccount(email, password) {
  await preLogin()
  const response = await fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      Authorization: runtime.basicAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': runtime.userAgent,
      'ETP-Anonymous-ID': runtime.anonId,
      Cookie: runtime.cookies,
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: email,
      password,
      scope: 'offline_access',
      device_id: getDeviceId(),
      device_type: 'ANDROIDTV',
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error_description || error.error || `HTTP ${response.status}`)
  }
  const data = await response.json()
  const cfg = loadCfg()
  Object.assign(cfg, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenExp: Date.now() + (data.expires_in || 300) * 1000,
    accountId: data.account_id || null,
    loggedIn: true,
  })
  saveCfg(cfg)
  runtime.token = data.access_token
  runtime.tokenExp = cfg.tokenExp
}

async function refreshAccountToken() {
  const cfg = loadCfg()
  if (!cfg.refreshToken) throw new Error('Sin refresh token; usa /crlogin nuevamente.')
  await preLogin()
  const response = await fetch(CR_AUTH, {
    method: 'POST',
    headers: {
      Authorization: runtime.basicAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': runtime.userAgent,
      'ETP-Anonymous-ID': runtime.anonId,
      Cookie: runtime.cookies,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
      scope: 'offline_access',
      device_id: getDeviceId(),
      device_type: 'ANDROIDTV',
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Refresh HTTP ${response.status}`)
  const data = await response.json()
  cfg.accessToken = data.access_token
  cfg.refreshToken = data.refresh_token || cfg.refreshToken
  cfg.tokenExp = Date.now() + (data.expires_in || 300) * 1000
  saveCfg(cfg)
  runtime.token = data.access_token
  runtime.tokenExp = cfg.tokenExp
  return runtime.token
}

async function getToken() {
  const cfg = loadCfg()
  if (!cfg.loggedIn) return getAnonToken()
  if (runtime.token && Date.now() < runtime.tokenExp - 30_000) return runtime.token
  if (cfg.accessToken && cfg.tokenExp && Date.now() < cfg.tokenExp - 30_000) {
    runtime.token = cfg.accessToken
    runtime.tokenExp = cfg.tokenExp
    return runtime.token
  }
  return refreshAccountToken()
}

async function crFetch(endpoint, params = {}, base = CR_BASE, timeoutMs = 20_000) {
  const url = new URL(`${base}${endpoint}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken()
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': runtime.userAgent,
        Accept: 'application/json',
        Cookie: runtime.cookies,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return response.json()
    if (response.status === 401 && attempt === 0) {
      runtime.token = null
      runtime.tokenExp = 0
      runtime.cookiesExp = 0
      const cfg = loadCfg()
      if (cfg.loggedIn) {
        delete cfg.accessToken
        delete cfg.tokenExp
        saveCfg(cfg)
      }
      continue
    }
    const detail = (await response.text().catch(() => '')).slice(0, 160)
    throw new Error(`CR API HTTP ${response.status} → ${endpoint}${detail ? `: ${detail}` : ''}`)
  }
  throw new Error(`No se pudo renovar el token → ${endpoint}`)
}

function extractImage(images = {}) {
  const candidates = Object.values(images).flat(Infinity).filter(Boolean).map((item) => {
    if (typeof item === 'string') return { source: item, size: 0 }
    if (typeof item !== 'object') return null
    return { source: item.source || item.url || '', size: (Number(item.width) || 0) * (Number(item.height) || 0) }
  }).filter((item) => item?.source)
  return candidates.sort((a, b) => b.size - a.size)[0]?.source || ''
}

function normalizeEpisode(item) {
  const meta = item?.episode_metadata || {}
  const epNum = item?.episode_number ?? meta.episode_number ?? 'Especial'
  const locale = item?.audio_locale || meta.audio_locale || meta.audio_locales?.[0] || ''
  const season = item?.season_title || meta.season_title || ''
  let series = item?.series_title || meta.series_title || item?.title || 'Anime desconocido'
  if (season && series && !series.includes(season) && !season.startsWith(series)) series += ` ${season}`
  const id = item?.id || ''
  const slug = item?.slug_title || meta.slug_title || ''
  return {
    id,
    series: series.trim(),
    epTitle: item?.title || '',
    epNum,
    audioLocale: locale,
    image: extractImage(item?.images),
    airTime: item?.premium_available_date || item?.availability_starts || '',
    link: `https://www.crunchyroll.com/watch/${id}${slug ? `/${slug}` : ''}`,
  }
}

function stripCdata(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function parseRss(xml) {
  const episodes = []
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    const tag = (name) => stripCdata(block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '')
    const title = tag('title')
    const link = tag('link') || block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || ''
    const guid = tag('guid')
    const id = link.match(/\/watch\/([^/\s?#]+)/)?.[1] || guid
    const number = title.match(/(?:Episode|Ep\.?|E)\s*(\d+)/i)?.[1]
    const image = block.match(/<media:thumbnail\b[^>]*url="([^"]+)"/i)?.[1] || ''
    if (id && title && link) episodes.push({
      id,
      series: title.replace(/\s*(?:Episode|Ep\.?|E)\s*\d+.*$/i, '').trim() || title,
      epTitle: '',
      epNum: number ? Number(number) : 'Especial',
      audioLocale: 'ja-JP',
      image,
      link,
      airTime: tag('pubDate'),
    })
  }
  return episodes
}

async function fetchRssEpisodes() {
  const response = await fetch(CR_RSS, { headers: { Accept: 'application/rss+xml, application/xml', 'User-Agent': runtime.userAgent }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`RSS HTTP ${response.status}`)
  const xml = await response.text()
  if (xml.length > 2 * 1024 * 1024) throw new Error('RSS demasiado grande')
  return parseRss(xml)
}

async function fetchBrowseEpisodes() {
  const pageCount = Math.max(1, Math.floor(envNum('CR_PAGES', 1, 1)))
  const responses = await Promise.allSettled(Array.from({ length: pageCount }, (_, index) => crFetch('/content/v2/discover/browse', {
    count: 100,
    start: index * 100,
    sort_by: 'newly_added',
    type: 'episode',
    locale: 'es-419',
  }, CR_BETA, BROWSE_TIMEOUT_MS)))

  const rows = []
  responses.forEach((result, index) => {
    if (result.status === 'fulfilled') rows.push(...(Array.isArray(result.value?.data) ? result.value.data : result.value?.items || []))
    else if (index === 0) throw result.reason
    else console.warn(`[CR-Notify] Página ${index} falló: ${result.reason?.message || result.reason}`)
  })

  const allowed = new Set(['ja-JP', 'es-419', 'es-LA', 'es-ES'])
  return [...new Map(rows.map(normalizeEpisode).filter((episode) => episode.id && episode.series && allowed.has(episode.audioLocale)).map((episode) => [episode.id, episode])).values()]
}

async function fetchLatest() {
  try {
    const episodes = await fetchBrowseEpisodes()
    if (episodes.length) return episodes
  } catch (error) {
    console.warn(`[CR-Notify] Browse falló: ${error.message}. Probando RSS.`)
  }
  return fetchRssEpisodes()
}

async function fetchNew() {
  const current = await fetchLatest()
  if (!current.length) return []
  const seen = loadSeen()
  if (!seen.length) {
    saveSeen(current.map((episode) => episode.id))
    console.log(`[CR-Notify] Caché inicial sembrado con ${current.length} episodios.`)
    return []
  }
  return current.filter((episode) => !seen.includes(episode.id))
}

function markSeen(id) {
  const seen = loadSeen()
  if (!seen.includes(id)) saveSeen([...seen, id])
}

const FLAGS = { 'ja-JP': '🇯🇵', 'es-419': '🇲🇽', 'es-LA': '🇲🇽', 'es-ES': '🇪🇸' }
const LOCALES = { 'ja-JP': 'Japonés', 'es-419': 'Latino', 'es-LA': 'Latino', 'es-ES': 'Castellano' }

function caption(episode) {
  const flag = FLAGS[episode.audioLocale] || '🌐'
  const language = LOCALES[episode.audioLocale] || episode.audioLocale || 'Desconocido'
  const title = episode.epTitle ? `Ep. ${episode.epNum} - ${episode.epTitle}` : `Ep. ${episode.epNum}`
  return `📺 ${episode.series}\n🎬 ${title}\n${flag} ${language}\n\n${episode.link}`
}

async function sendEpisode(sock, jid, episode, quoted = null) {
  const text = caption(episode)
  const options = quoted ? { quoted } : {}
  if (episode.image) {
    try {
      await sock.sendMessage(jid, { image: { url: episode.image }, caption: text }, options)
      return
    } catch {}
  }
  await sock.sendMessage(jid, { text }, options)
}

async function withLock(fn) {
  const previous = runtime.lock
  let release
  runtime.lock = new Promise((resolve) => { release = resolve })
  await previous
  try { return await fn() } finally { release() }
}

function getSock(fallback) {
  return runtime.storedSock || fallback || global.sock || null
}

function stopCron() {
  if (runtime.cronTimer) clearInterval(runtime.cronTimer)
  runtime.cronTimer = null
}

function startCron(sock) {
  if (sock) runtime.storedSock = sock
  stopCron()
  const cfg = loadCfg()
  if (cfg.cronDisabled) return
  const minutesRaw = process.env.CR_MINUTES || cfg.minutes || 1
  const minutes = Math.max(1, Math.floor(Number(minutesRaw) || 1))
  runtime.cronTimer = setInterval(() => checkAndSend(getSock(), false).catch((error) => console.error('[CR-Notify] Cron:', error.message)), minutes * 60_000)
  runtime.cronTimer.unref?.()
  console.log(`[CR-Notify] Cron activo cada ${minutes} min. Grupos: ${(cfg.targetJids || []).length}.`)
}

async function checkAndSend(sock, manual = false) {
  if (runtime.cronRunning || !sock) return 0
  const jids = loadCfg().targetJids || []
  if (!jids.length) return 0
  runtime.cronRunning = true
  try {
    return await withLock(async () => {
      const episodes = await fetchNew()
      if (!episodes.length) return 0
      let sent = 0
      for (const episode of episodes) {
        let successful = 0
        for (const jid of jids) {
          try {
            await sendEpisode(sock, jid, episode)
            successful++
            if (SEND_JID_DELAY_MS) await delay(SEND_JID_DELAY_MS)
          } catch (error) {
            console.error(`[CR-Notify] Error enviando ${episode.id} a ${jid}:`, error.message)
          }
        }
        // Se conserva para reintentar en la siguiente revisión si todos fallaron.
        if (successful === jids.length) {
          markSeen(episode.id)
          sent++
        }
        if (SEND_DELAY_MS) await delay(SEND_DELAY_MS)
      }
      console.log(`[CR-Notify] ${sent}/${episodes.length} episodio(s) enviados a ${jids.length} grupo(s).`)
      return sent
    })
  } finally {
    runtime.cronRunning = false
  }
}

function canManageGroup(msg, sock, isOwner) {
  if (isOwner) return true
  if (!msg.isGroup) return false
  return sock.groupMetadata(msg.chat).then((metadata) => {
    const sender = String(msg.sender || '').split('@')[0]
    return metadata?.participants?.some((participant) => {
      const ids = [participant.id, participant.lid, participant.phoneNumber].filter(Boolean).map((id) => String(id).split('@')[0])
      return ids.includes(sender) && ['admin', 'superadmin'].includes(participant.admin)
    })
  }).catch(() => false)
}

function usage(command = 'crnotify') {
  return `Uso: /${command} [1-50]` 
}

async function runLogin({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede iniciar sesión en Crunchyroll.')
  if (msg.isGroup) return msg.reply('⛔ Usa /crlogin únicamente por privado.')
  const email = args[0]
  const password = args.slice(1).join(' ')
  if (!email || !password) return msg.reply('💡 Uso: /crlogin correo contraseña')
  await msg.delete?.().catch(() => {})
  await msg.react?.('⏳').catch(() => {})
  try {
    await loginWithAccount(email, password)
    const cfg = loadCfg()
    cfg.cronDisabled = false
    saveCfg(cfg)
    startCron(sock)
    await msg.react?.('✅').catch(() => {})
  } catch (error) {
    console.error('[CR-Notify] Login:', error.message)
    await msg.react?.('❎').catch(() => {})
  }
}

async function runLogout({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const cfg = loadCfg()
  for (const key of ['accessToken', 'refreshToken', 'tokenExp', 'accountId', 'loggedIn']) delete cfg[key]
  saveCfg(cfg)
  runtime.token = null
  runtime.tokenExp = 0
  await msg.reply(`🔒 Sesión cerrada. Se conservaron ${cfg.targetJids.length} grupo(s). El cron continuará en modo anónimo.`)
}

async function runSet({ msg, sock, isOwner }) {
  if (!(await canManageGroup(msg, sock, isOwner))) return msg.reply('⛔ Solo un administrador del grupo o el dueño puede usar este comando.')
  const cfg = loadCfg()
  if (!cfg.targetJids.includes(msg.chat)) cfg.targetJids.push(msg.chat)
  cfg.cronDisabled = false
  saveCfg(cfg)
  startCron(sock)
  return msg.reply(`✅ Grupo añadido al notificador. Total: ${cfg.targetJids.length}`)
}

async function runRemove({ msg, sock, isOwner }) {
  if (!(await canManageGroup(msg, sock, isOwner))) return msg.reply('⛔ Solo un administrador del grupo o el dueño puede usar este comando.')
  const cfg = loadCfg()
  const before = cfg.targetJids.length
  cfg.targetJids = cfg.targetJids.filter((jid) => jid !== msg.chat)
  saveCfg(cfg)
  return msg.reply(before === cfg.targetJids.length ? '⚠️ Este grupo no estaba configurado.' : `🗑️ Grupo eliminado. Quedan: ${cfg.targetJids.length}`)
}

async function runStatus({ msg }) {
  const cfg = loadCfg()
  const seen = loadSeen()
  const minutes = Math.max(1, Math.floor(Number(process.env.CR_MINUTES || cfg.minutes || 1) || 1))
  const exp = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
  const groups = cfg.targetJids.length ? cfg.targetJids.map((jid, index) => `  ${index + 1}. ${jid}`).join('\n') : '  Ninguno — usa /crset'
  return msg.reply(
    `📊 *CR-Notify Status*\n\n` +
    `🔑 Modo: *${cfg.loggedIn ? 'Cuenta real' : 'Anónimo'}*\n` +
    `⏳ Token expira: *${exp}*\n` +
    `🔁 Refresh token: *${cfg.refreshToken ? 'Sí' : 'No'}*\n` +
    `⏱️ Cron: cada *${minutes} min*\n` +
    `🔄 Cron activo: *${runtime.cronTimer ? 'Sí' : (cfg.cronDisabled ? 'Detenido' : 'No')}*\n` +
    `💾 Episodios registrados: *${seen.length}*\n` +
    `🔐 Credenciales: *${runtime.credentialCache.source}*\n\n` +
    `🎯 *Grupos configurados (${cfg.targetJids.length}):*\n${groups}`
  )
}

async function runList({ msg, sock, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  await msg.react?.('⏳').catch(() => {})
  try {
    const episodes = await fetchLatest().then((items) => items.slice(0, 10))
    if (!episodes.length) return msg.reply('📭 No se encontraron episodios recientes.')
    for (const episode of episodes) {
      await sendEpisode(sock, msg.chat, episode, msg)
      if (SEND_DELAY_MS) await delay(SEND_DELAY_MS)
    }
    await msg.react?.('✅').catch(() => {})
  } catch (error) {
    console.error('[CR-Notify] Lista:', error.message)
    await msg.react?.('❎').catch(() => {})
  }
}

async function runNotify({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const raw = args[0]
  const limit = raw === undefined ? 1 : Math.min(50, Number(raw))
  if (!Number.isInteger(limit) || limit < 1) return msg.reply(usage())
  const cfg = loadCfg()
  const jids = cfg.targetJids.length ? cfg.targetJids : [msg.chat]
  await msg.react?.('⏳').catch(() => {})
  try {
    const episodes = (await fetchLatest()).slice(0, limit)
    if (!episodes.length) return msg.reply('📭 No se encontraron episodios.')
    for (const episode of episodes) {
      for (const jid of jids) {
        await sendEpisode(sock, jid, episode)
        if (SEND_JID_DELAY_MS) await delay(SEND_JID_DELAY_MS)
      }
      if (SEND_DELAY_MS) await delay(SEND_DELAY_MS)
    }
    await msg.react?.('✅').catch(() => {})
  } catch (error) {
    console.error('[CR-Notify] Notify:', error.message)
    await msg.react?.('❎').catch(() => {})
  }
}

async function runStop({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const cfg = loadCfg()
  cfg.cronDisabled = true
  saveCfg(cfg)
  stopCron()
  return msg.reply('🛑 Cron detenido. Usa /crstart para reanudarlo.')
}

async function runStart({ msg, sock, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const cfg = loadCfg()
  cfg.cronDisabled = false
  saveCfg(cfg)
  startCron(sock)
  return msg.reply('▶️ Cron iniciado.')
}

async function runDiag({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  await msg.react?.('⏳').catch(() => {})
  const lines = []
  try {
    await refreshCredentials()
    lines.push(`📡 Credenciales: *${runtime.credentialCache.source}*`)
    lines.push(`🔐 Basic Auth: *${runtime.basicAuth === BASIC_AUTH_FALLBACK ? 'fallback' : 'activa'}*`)
    lines.push(`🧭 User-Agent: \`${runtime.userAgent.slice(0, 48)}...\``)
    try {
      const token = await getAnonToken()
      lines.push(`✅ Auth anónima: *OK* (\`${token.slice(0, 12)}...\`)`)
    } catch (error) {
      lines.push(`❎ Auth anónima: *FALLÓ* — ${error.message}`)
    }
    try {
      const rss = await fetchRssEpisodes()
      lines.push(`📰 RSS: *OK* (${rss.length} ítems)`)
    } catch (error) {
      lines.push(`❎ RSS: *FALLÓ* — ${error.message}`)
    }
  } catch (error) {
    lines.push(`❎ Error general: ${error.message}`)
  }
  await msg.react?.('✅').catch(() => {})
  return msg.reply(`🩺 *CR-Notify Diagnóstico*\n\n${lines.join('\n')}`)
}

async function runCommand({ msg, sock, command, args, isOwner }) {
  runtime.storedSock = sock
  if (command === 'crlogin') return runLogin({ msg, sock, args, isOwner })
  if (command === 'crlogout') return runLogout({ msg, isOwner })
  if (command === 'crset') return runSet({ msg, sock, isOwner })
  if (command === 'crrem') return runRemove({ msg, sock, isOwner })
  if (command === 'crstatus') return runStatus({ msg })
  if (command === 'crlist') return runList({ msg, sock, isOwner })
  if (command === 'crnotify') return runNotify({ msg, sock, args, isOwner })
  if (command === 'crstop') return runStop({ msg, isOwner })
  if (command === 'crstart') return runStart({ msg, sock, isOwner })
  if (command === 'crdiag') return runDiag({ msg, isOwner })
}

export default {
  command: ['crlogin', 'crlogout', 'crset', 'crrem', 'crstatus', 'crlist', 'crnotify', 'crstop', 'crstart', 'crdiag'],
  category: 'anime',
  description: 'Notificador de estrenos de Crunchyroll con API y RSS de respaldo.',
  run: runCommand,
}
