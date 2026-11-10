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
const CREDENTIALS_URL = 'https://raw.githubusercontent.com/vitalygashkov/crextractor/refs/heads/main/credentials.tv.json'
const BASIC_ANON_FALLBACK = 'Basic bmR0aTZicXlqcm9wNXZnZjF0dnU6elpIcS00SEJJVDlDb2FMcnBPREJjRVRCTUNHai1QNlg='
const BASIC_AUTH_FALLBACK = 'Basic eTJhcnZqYjBoMHJndnRpemxvdnk6SlZWdndkSXBYdnhVLXFJQnZUMU04b1FUcjFxbFFKWDI='
const CR_UA_FALLBACK = 'Crunchyroll/ANDROIDTV/3.76.0_22366 (Android 16; en-US; sdk_gphone64_x86_64)'
const NX_BASIC = 'Basic ZXI5bmdnMmtvNW9oaXJsYTUxaTI6VmwxVDBQbjhRWko2d3o0NnhYRGxIekRGUDV0Wlgxb3E='
const NX_UA = 'Crunchyroll/ANDROIDTV/3.76.0_22366 (Android 12; en-US; SHIELD Android TV Build/SR1A.220624.014)'
const WEB_BASIC = 'Basic bm9haWhkZXZtXzZpeWcwYThsMHE6'
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const ENV_BASIC_ANON = (process.env.CR_BASIC_ANON || NX_BASIC).trim()
const ENV_BASIC_AUTH = (process.env.CR_BASIC_AUTH || NX_BASIC).trim()
const ENV_USER_AGENT = (process.env.CR_USER_AGENT || NX_UA).trim().replace(/[\u0000-\u001f\u007f]/g, '')

const SEND_JID_DELAY_MS = envNum('CR_SEND_JID_DELAY_MS', 1500)
const SEND_DELAY_MS = envNum('CR_SEND_DELAY_MS', 1000)
const BROWSE_TIMEOUT_MS = envNum('CR_BROWSE_TIMEOUT_MS', 20000, 1000)
const HEALTH_INTERVAL_MS = 30 * 60_000
const CREDENTIAL_CACHE_MS = 6 * 60 * 60_000
const CREDENTIAL_RETRY_MS = 15 * 60_000
const COOKIE_TTL_MS = 6 * 60 * 60_000
const CR_PREFIX = (process.env.BOT_PREFIX || '`').trim().split(/\s+/)[0] || '`'

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
  userAgent: ENV_USER_AGENT || CR_UA_FALLBACK,
  credentialCache: { exp: 0, source: 'fallback', lastError: null },
  credentialRefresh: null,
  lock: Promise.resolve(),
}

applyOverrides()

function envNum(name, fallback, min = 0) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let wreq = null
try {
  wreq = await import('wreq-js')
} catch {
  console.warn('[CR-Notify] wreq-js no está instalado; usando fetch nativo (Cloudflare puede bloquear). Instala con: npm i wreq-js')
}

const TLS_PROFILE_TV = (process.env.CR_TLS_PROFILE_TV || 'okhttp_4_12').trim()
const TLS_PROFILE_WEB = (process.env.CR_TLS_PROFILE_WEB || 'chrome_124').trim()
let knownProfiles = null

function pickProfile(wanted) {
  if (!wreq) return undefined
  try { knownProfiles ??= new Set(wreq.getProfiles?.() || []) } catch { knownProfiles = new Set() }
  if (!knownProfiles.size || knownProfiles.has(wanted)) return wanted
  console.warn(`[CR-Notify] Perfil TLS "${wanted}" no existe en wreq-js; usando el predeterminado de la librería.`)
  return undefined
}

async function tlsFetch(url, options = {}) {
  if (!wreq) return fetch(url, options)
  const headers = {}
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null && value !== '') headers[key] = value
  }
  const web = headers['User-Agent'] === WEB_UA
  const browser = pickProfile(web ? TLS_PROFILE_WEB : TLS_PROFILE_TV)
  return wreq.fetch(url, { ...options, headers, ...(browser ? { browser } : {}) })
}

function readSetCookies(response) {
  const list = response.headers?.getSetCookie?.()
  if (Array.isArray(list) && list.length) return list.map((cookie) => cookie.split(';')[0])
  if (response.cookies && typeof response.cookies === 'object') return Object.entries(response.cookies).map(([key, value]) => `${key}=${value}`)
  const raw = response.headers?.get?.('set-cookie')
  return raw ? raw.split(/,(?=\s*[^;,\s]+=)/).map((cookie) => cookie.trim().split(';')[0]) : []
}

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

function applyOverrides() {
  if (isValidBasic(ENV_BASIC_ANON)) runtime.basicAnon = ENV_BASIC_ANON
  if (isValidBasic(ENV_BASIC_AUTH)) runtime.basicAuth = ENV_BASIC_AUTH
  if (ENV_USER_AGENT) runtime.userAgent = ENV_USER_AGENT
}

function applyCredentials(authorization, client, basicAuth) {
  runtime.basicAnon = authorization
  if (basicAuth) runtime.basicAuth = basicAuth
  runtime.userAgent = `Crunchyroll/ANDROIDTV/${client.version}_${client.build} (Android 16; en-US; sdk_gphone64_x86_64)`
  applyOverrides()
}

function sessionUA(cfg) {
  return cfg?.loggedIn && cfg.authMode === 'web' ? WEB_UA : runtime.userAgent
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
      applyOverrides()
      runtime.credentialCache = { exp: Date.now() + CREDENTIAL_RETRY_MS, source: 'fallback', lastError: runtime.credentialCache.lastError }
    }
  })().finally(() => { runtime.credentialRefresh = null })

  return runtime.credentialRefresh
}

async function preLogin(force = false) {
  if (!force && runtime.cookies && Date.now() < runtime.cookiesExp) return
  await refreshCredentials()
  try {
    const response = await tlsFetch(CR_BASE, {
      headers: { 'User-Agent': runtime.userAgent },
      signal: AbortSignal.timeout(15000),
    })
    runtime.cookies = readSetCookies(response).join('; ')
    runtime.cookiesExp = Date.now() + COOKIE_TTL_MS
  } catch {}
}

async function getAnonToken() {
  if (runtime.token && Date.now() < runtime.tokenExp - 30_000) return runtime.token
  await refreshCredentials()
  await preLogin()

  const response = await tlsFetch(CR_AUTH, {
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

async function loginWithEtpRt(etpRt) {
  const response = await tlsFetch(CR_AUTH, {
    method: 'POST',
    headers: {
      Authorization: WEB_BASIC,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': WEB_UA,
      Cookie: `etp_rt=${etpRt}`,
    },
    body: new URLSearchParams({ grant_type: 'etp_rt_cookie' }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error_description || error.error || `HTTP ${response.status}`)
  }
  const data = await response.json()
  if (!data.access_token) throw new Error('respuesta sin access_token')
  const cfg = loadCfg()
  Object.assign(cfg, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenExp: Date.now() + (data.expires_in || 300) * 1000,
    accountId: data.account_id || null,
    loggedIn: true,
    authMode: 'web',
    etpRt,
  })
  saveCfg(cfg)
  runtime.token = data.access_token
  runtime.tokenExp = cfg.tokenExp
}

async function loginWithAccount(email, password) {
  await preLogin()
  const response = await tlsFetch(CR_AUTH, {
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
    authMode: 'tv',
  })
  delete cfg.etpRt
  saveCfg(cfg)
  runtime.token = data.access_token
  runtime.tokenExp = cfg.tokenExp
}

async function refreshWebToken(cfg) {
  if (cfg.refreshToken) {
    const response = await tlsFetch(CR_AUTH, {
      method: 'POST',
      headers: {
        Authorization: WEB_BASIC,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': WEB_UA,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.refreshToken,
        scope: 'offline_access',
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) {
      const data = await response.json()
      cfg.accessToken = data.access_token
      cfg.refreshToken = data.refresh_token || cfg.refreshToken
      cfg.tokenExp = Date.now() + (data.expires_in || 300) * 1000
      saveCfg(cfg)
      runtime.token = data.access_token
      runtime.tokenExp = cfg.tokenExp
      return runtime.token
    }
  }
  if (!cfg.etpRt) throw new Error(`Sin sesión web; usa ${CR_PREFIX}crlogin nuevamente.`)
  await loginWithEtpRt(cfg.etpRt)
  return runtime.token
}

async function refreshAccountToken() {
  const cfg = loadCfg()
  if (cfg.authMode === 'web') return refreshWebToken(cfg)
  if (!cfg.refreshToken) throw new Error(`Sin refresh token; usa ${CR_PREFIX}crlogin nuevamente.`)
  await preLogin()
  const response = await tlsFetch(CR_AUTH, {
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
    const response = await tlsFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': sessionUA(loadCfg()),
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
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
    subLocales: [...(Array.isArray(item?.subtitle_locales) ? item.subtitle_locales : []), ...(Array.isArray(meta.subtitle_locales) ? meta.subtitle_locales : [])].filter((x) => typeof x === 'string'),
    image: extractImage(item?.images),
    airTime: Date.parse(item?.premium_available_date || item?.availability_starts || item?.episode_metadata?.episode_air_date || '') || 0,
    link: `https://www.crunchyroll.com/watch/${id}${slug ? `/${slug}` : ''}`,
  }
}

async function fetchBrowseEpisodes() {
  const pageCount = Math.max(1, Math.floor(envNum('CR_PAGES', 2, 1)))
  const browsePage = async (index) => {
    const params = { count: 100, start: index * 100, sort_by: 'newly_added', type: 'episode', locale: 'es-419' }
    try {
      return await crFetch('/content/v2/discover/browse', { ...params, _: Date.now() }, CR_BETA, BROWSE_TIMEOUT_MS)
    } catch (error) {
      if (!/HTTP 400/.test(error.message)) throw error
      return crFetch('/content/v2/discover/browse', params, CR_BETA, BROWSE_TIMEOUT_MS)
    }
  }
  const responses = await Promise.allSettled(Array.from({ length: pageCount }, (_, index) => browsePage(index)))

  const rows = []
  responses.forEach((result, index) => {
    if (result.status === 'fulfilled') rows.push(...(Array.isArray(result.value?.data) ? result.value.data : result.value?.items || []))
    else if (index === 0) throw result.reason
    else console.warn(`[CR-Notify] Página ${index} falló: ${result.reason?.message || result.reason}`)
  })

  const allowed = new Set(['ja-JP', 'es-419', 'es-LA', 'es-ES'])
  const normalized = rows.map(normalizeEpisode)
  const accepted = []
  for (const episode of normalized) {
    if (!episode.id || !episode.series) {
      console.log(`[CR-Notify] Descartado: datos incompletos | ID: ${episode.id || '(vacío)'} | Serie: ${episode.series || '(vacía)'}`)
      continue
    }
    if (episode.audioLocale && !allowed.has(episode.audioLocale)) {
      console.log(`[CR-Notify] Descartado por idioma: ${episode.audioLocale || '(vacío)'} | ${episode.series} | ${episode.id}`)
      continue
    }
    accepted.push(episode)
  }
  const unique = [...new Map(accepted.map((episode) => [episode.id, episode])).values()]
  unique.sort((x, y) => (y.airTime - x.airTime) || String(x.series).localeCompare(String(y.series)) || (Number(x.epNum) || 0) - (Number(y.epNum) || 0))
  console.log(`[CR-Notify] Browse: ${rows.length} recibidos | ${unique.length} aceptados | ${normalized.length - accepted.length} descartados`)
  return unique
}

async function fetchLatest() {
  return fetchBrowseEpisodes()
}

async function fetchNew() {
  const current = await fetchLatest()
  if (!current.length) {
    console.log('[CR-Notify] Revisión: no se encontraron episodios válidos.')
    return []
  }
  const seen = loadSeen()
  if (!seen.length) {
    saveSeen(current.map((episode) => episode.id))
    console.log(`[CR-Notify] Caché inicial sembrado con ${current.length} episodios.`)
    return []
  }
  const fresh = current.filter((episode) => !seen.includes(episode.id))
  console.log(`[CR-Notify] Revisión: ${current.length} válidos | ${fresh.length} nuevos | ${seen.length} registrados.`)
  return fresh.sort((x, y) => x.airTime - y.airTime)
}

function markSeen(id) {
  const seen = loadSeen()
  if (!seen.includes(id)) saveSeen([...seen, id])
}

const FLAGS = { 'ja-JP': '🇯🇵', 'es-419': '🇲🇽', 'es-LA': '🇲🇽', 'es-ES': '🇪🇸' }
const LOCALES = { 'ja-JP': 'Japonés', 'es-419': 'Latino', 'es-LA': 'Latino', 'es-ES': 'Castellano' }

function subtitleLine(episode) {
  if (episode.audioLocale !== 'ja-JP') return ''
  const subs = new Set(episode.subLocales || [])
  if (subs.has('es-419') || subs.has('es-LA')) return '> 🇲🇽 Sub Español\n'
  if (subs.has('es-ES')) return '> 🇪🇸 Sub Español Castellano\n'
  if ([...subs].some((code) => code.startsWith('en-'))) return '> 🇺🇸 Sub English\n'
  return ''
}

function caption(episode) {
  const flag = FLAGS[episode.audioLocale] || '🌐'
  const language = LOCALES[episode.audioLocale] || episode.audioLocale || 'Desconocido'
  const title = episode.epTitle ? `Ep. ${episode.epNum} - ${episode.epTitle}` : `Ep. ${episode.epNum}`
  return `📺 ${episode.series}\n🎬 ${title}\n${flag} ${language}\n${subtitleLine(episode)}\n${episode.link}`
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
  if (cfg.cronDisabled) {
    console.log('[CR-Notify] Monitoreo detenido por configuración. Usa `crstart para reanudarlo.')
    return
  }
  const minutesRaw = cfg.minutes || process.env.CR_MINUTES || 1
  const minutes = Math.max(1, Math.floor(Number(minutesRaw) || 1))
  runtime.cronTimer = setInterval(() => checkAndSend(getSock(), false).catch((error) => console.error('[CR-Notify] Cron:', error.message)), minutes * 60_000)
  runtime.cronTimer.unref?.()
  setTimeout(() => checkAndSend(getSock(), false).catch((error) => console.error('[CR-Notify] Cron:', error.message)), 10_000).unref?.()
  console.log(`[CR-Notify] Cron activo → cada ${minutes} min | ${(cfg.targetJids || []).length} grupo(s) configurado(s)`)
  console.log(`[CR-Notify] Auto-inicio | Grupos: ${(cfg.targetJids || []).length} | Modo: ${cfg.loggedIn ? 'Cuenta real' : 'Anónimo'} | Cron: ON`)
  console.log(`[CR-Notify] Delays → JID: ${SEND_JID_DELAY_MS}ms | Ep: ${SEND_DELAY_MS}ms | Browse: ${BROWSE_TIMEOUT_MS}ms`)
}

async function checkAndSend(sock, manual = false) {
  if (runtime.cronRunning || !sock) return 0
  const jids = loadCfg().targetJids || []
  if (!jids.length) {
    if (manual) console.log('[CR-Notify] Revisión manual omitida: no hay grupos configurados.')
    return 0
  }
  console.log(`[CR-Notify] Revisión ${manual ? 'manual' : 'programada'} iniciada | Grupos: ${jids.length}`)
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
  return `Uso: ${CR_PREFIX}${command} [1-50]`
}

async function runLogin({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede iniciar sesión en Crunchyroll.')
  if (msg.isGroup) return msg.reply(`⛔ Usa ${CR_PREFIX}crlogin únicamente por privado.`)
  const first = args[0]
  const password = args.slice(1).join(' ')
  const usageText = `💡 Uso: ${CR_PREFIX}crlogin correo contraseña\nO: ${CR_PREFIX}crlogin etp_rt`
  if (!first) return msg.reply(usageText)
  const tokenLogin = !password
  if (tokenLogin && (first.includes('@') || !/^[A-Za-z0-9._~-]{8,256}$/.test(first))) return msg.reply(usageText)
  await msg.delete?.().catch(() => {})
  await msg.react?.('⏳').catch(() => {})
  try {
    if (tokenLogin) await loginWithEtpRt(first)
    else await loginWithAccount(first, password)
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
  for (const key of ['accessToken', 'refreshToken', 'tokenExp', 'accountId', 'loggedIn', 'authMode', 'etpRt']) delete cfg[key]
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
  const minutes = Math.max(1, Math.floor(Number(cfg.minutes || process.env.CR_MINUTES || 1) || 1))
  const exp = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
  const groups = cfg.targetJids.length ? cfg.targetJids.map((jid, index) => `  ${index + 1}. ${jid}`).join('\n') : `  Ninguno — usa ${CR_PREFIX}crset`
  return msg.reply(
    `📊 *CR-Notify Status*\n\n` +
    `🔑 Modo: *${cfg.loggedIn ? (cfg.authMode === 'web' ? 'Cuenta real (etp_rt)' : 'Cuenta real') : 'Anónimo'}*\n` +
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
  return msg.reply(`🛑 Cron detenido. Usa ${CR_PREFIX}crstart para reanudarlo.`)
}

async function runStart({ msg, sock, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const cfg = loadCfg()
  cfg.cronDisabled = false
  saveCfg(cfg)
  startCron(sock)
  return msg.reply('▶️ Cron iniciado.')
}

async function runInterval({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede cambiar el intervalo global.')
  const raw = args[0]
  if (raw === undefined) return msg.reply(`Uso: ${CR_PREFIX}crinterval [1-1440] minutos`)
  const minutes = Number(raw)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return msg.reply('⛔ Intervalo no válido. Usa un número entero de 1 a 1440 minutos.')
  }
  const cfg = loadCfg()
  cfg.minutes = minutes
  saveCfg(cfg)
  if (!cfg.cronDisabled) startCron(sock)
  return msg.reply(cfg.cronDisabled
    ? `✅ Intervalo guardado: cada ${minutes} min. El cron sigue detenido; usa ${CR_PREFIX}crstart para iniciarlo.`
    : `✅ Intervalo actualizado: cada ${minutes} min.`)
}

async function runDiag({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  await msg.react?.('⏳').catch(() => {})
  const lines = []
  try {
    await refreshCredentials()
    lines.push(`📡 Credenciales: *${runtime.credentialCache.source}*`)
    lines.push(`🔒 TLS: *${wreq ? `wreq-js (${TLS_PROFILE_TV} / ${TLS_PROFILE_WEB})` : 'fetch nativo'}*`)
    lines.push(`🔐 Basic Auth: *${runtime.basicAuth === NX_BASIC ? 'nx' : 'personalizada'}*`)
    lines.push(`🧭 User-Agent: \`${runtime.userAgent.slice(0, 48)}...\``)
    try {
      const token = await getAnonToken()
      lines.push(`✅ Auth anónima: *OK* (\`${token.slice(0, 12)}...\`)`)
    } catch (error) {
      lines.push(`❎ Auth anónima: *FALLÓ* — ${error.message}`)
    }
    try {
      const episodes = await fetchBrowseEpisodes()
      lines.push(`📚 API Browse: *OK* (${episodes.length} episodios)`)
    } catch (error) {
      lines.push(`❎ API Browse: *FALLÓ* — ${error.message}`)
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
  if (command === 'crinterval') return runInterval({ msg, sock, args, isOwner })
  if (command === 'crdiag') return runDiag({ msg, isOwner })
}

export default {
  command: ['crlogin', 'crlogout', 'crset', 'crrem', 'crstatus', 'crlist', 'crnotify', 'crstop', 'crstart', 'crinterval', 'crdiag'],
  category: 'anime',
  description: 'Notificador de estrenos de Crunchyroll mediante la API.',
  run: runCommand,
}

console.log('[CR-Notify] Plugin cargado. Esperando la conexión de WhatsApp...')
let autoStartAttempts = 0
const autoStartTimer = setInterval(() => {
  autoStartAttempts++
  const sock = getSock()
  if (sock || autoStartAttempts >= 30) {
    clearInterval(autoStartTimer)
    if (sock) startCron(sock)
    else console.warn('[CR-Notify] WhatsApp todavía no está conectado; usa `crstart después de conectar.')
  }
}, 1000)
autoStartTimer.unref?.()
