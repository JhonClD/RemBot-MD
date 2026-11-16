import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TMP_DIR = path.resolve('lib/system/tmp/cr-notify')
const DB_PATH = path.join(TMP_DIR, 'crunchyroll-seen.json')
const TRACKS_PATH = path.join(TMP_DIR, 'crunchyroll-tracks.json')
const CFG_PATH = path.join(TMP_DIR, 'crunchyroll-cfg.json')
const ANILIST_CACHE_PATH = path.join(TMP_DIR, 'anilist-titles.json')
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
const ANILIST_TIMEOUT_MS = envNum('CR_ANILIST_TIMEOUT_MS', 4000, 1)
const ANILIST_CACHE_TTL_MS = 30 * 24 * 60 * 60_000
const ANILIST_NO_MATCH_TTL_MS = 6 * 60 * 60_000
const ANILIST_ERROR_TTL_MS = 2 * 60_000
const ANILIST_CACHE_MAX_ENTRIES = 1000
const CREDENTIAL_CACHE_MS = 6 * 60 * 60_000
const CREDENTIAL_RETRY_MS = 15 * 60_000
const COOKIE_TTL_MS = 6 * 60 * 60_000
const CR_PREFIX = (process.env.BOT_PREFIX || '`').trim().split(/\s+/)[0] || '`'

fs.mkdirSync(TMP_DIR, { recursive: true })
try { fs.chmodSync(TMP_DIR, 0o700) } catch {}
for (const file of [DB_PATH, TRACKS_PATH, CFG_PATH, ANILIST_CACHE_PATH]) {
  if (fs.existsSync(file)) {
    try { fs.chmodSync(file, 0o600) } catch {}
  }
}

const runtime = globalThis.__rembotCrunchyrollNotify ??= {
  cronTimer: null,
  cronGen: 0,
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

let impit = null
try {
  const { Impit } = await import('impit')
  impit = new Impit({ browser: 'chrome' })
} catch {
  console.warn('[CR-Notify] impit no está instalado; usando fetch nativo (Cloudflare puede bloquear). Instala con: npm i impit')
}

async function tlsFetch(url, options = {}) {
  if (!impit) return fetch(url, options)
  const headers = {}
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null && value !== '') headers[key] = value
  }
  return impit.fetch(url, { ...options, headers })
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

const rawAnilistDiskCache = loadJson(ANILIST_CACHE_PATH, {})
const rawAnilistDiskEntries = rawAnilistDiskCache && typeof rawAnilistDiskCache === 'object' && !Array.isArray(rawAnilistDiskCache)
  ? Object.entries(rawAnilistDiskCache)
  : []
const anilistCacheNow = Date.now()
const anilistDiskCache = Object.fromEntries(rawAnilistDiskEntries
  .filter(([, entry]) => entry && typeof entry.title === 'string' && Number.isFinite(entry.savedAt) && entry.savedAt <= anilistCacheNow && anilistCacheNow - entry.savedAt < ANILIST_CACHE_TTL_MS)
  .sort((a, b) => a[1].savedAt - b[1].savedAt)
  .slice(-ANILIST_CACHE_MAX_ENTRIES))
if (Object.keys(anilistDiskCache).length !== rawAnilistDiskEntries.length) {
  try { atomicWrite(ANILIST_CACHE_PATH, anilistDiskCache) } catch {}
}
const anilistMemoryCache = new Map()
const anilistInFlight = new Map()

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

function loadTrackState() {
  const state = loadJson(TRACKS_PATH, {})
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {}
  return Object.fromEntries(Object.entries(state).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)))
}

function saveTrackState(state) {
  atomicWrite(TRACKS_PATH, Object.fromEntries(Object.entries(state).slice(-MAX_SEEN)))
}

function rememberEpisodeTracks(state, episode) {
  const previous = state[episode.id] || {}
  const subLocales = [...new Set([...(Array.isArray(previous.subLocales) ? previous.subLocales : []), ...(episode.subLocales || [])])]
  delete state[episode.id]
  state[episode.id] = {
    audioLocale: episode.audioLocale || previous.audioLocale || '',
    subLocales,
  }
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

const LOCALE_ALIASES = {
  'es-419': 'es-419', 'es-la': 'es-419', 'es-mx': 'es-419', 'es-latam': 'es-419', 'es-us': 'es-419', 'es-ar': 'es-419', 'es-co': 'es-419', 'es-cl': 'es-419', 'es-pe': 'es-419',
  es419: 'es-419', esla: 'es-419', eses: 'es-ES',
  'es-es': 'es-ES', es: 'es-ES',
  ja: 'ja-JP', jajp: 'ja-JP', 'ja-jp': 'ja-JP',
  zh: 'zh-CN', zhcn: 'zh-CN', zhhans: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN', 'zh-sg': 'zh-CN', 'zh-my': 'zh-CN',
  zhtw: 'zh-TW', zhhant: 'zh-TW', 'zh-tw': 'zh-TW', 'zh-hant': 'zh-TW', 'zh-hk': 'zh-TW',
  kokr: 'ko-KR', 'ko-kr': 'ko-KR',
}

const LOCALE_LABELS = {
  'castilian': 'es-ES', castellano: 'es-ES', 'espanol espana': 'es-ES', 'español españa': 'es-ES', 'spanish spain': 'es-ES',
  'latin spanish': 'es-419', 'latam spanish': 'es-419', 'spanish latin america': 'es-419', 'espanol latino': 'es-419', 'español latino': 'es-419',
  japanese: 'ja-JP', japonés: 'ja-JP', japones: 'ja-JP',
  chinese: 'zh-CN', chino: 'zh-CN', 'simplified chinese': 'zh-CN', 'traditional chinese': 'zh-TW',
}
const IGNORED_LOCALES = new Set(['zh-TW'])
const TRACKED_SUBTITLE_LOCALES = new Set(['es-419', 'es-ES'])

function isTrackedSubtitleLocale(locale) {
  return TRACKED_SUBTITLE_LOCALES.has(locale) || locale.startsWith('en-')
}

function localeKey(value) {
  return String(value).trim().replace(/_/g, '-').replace(/[()]/g, '').replace(/\s+/g, ' ').toLowerCase()
}

function normalizeLocale(code) {
  if (typeof code !== 'string') return ''
  const raw = code.trim().replace(/_/g, '-')
  if (!raw) return ''
  const key = localeKey(raw)
  if (LOCALE_ALIASES[key]) return LOCALE_ALIASES[key]
  if (LOCALE_LABELS[key]) return LOCALE_LABELS[key]
  const [lang, region] = raw.split('-')
  return region ? `${lang.toLowerCase()}-${region.length === 2 ? region.toUpperCase() : region}` : lang.toLowerCase()
}

function localeFromId(id) {
  const compact = String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const suffixAliases = {
    ES419: 'es-419', ESLA: 'es-419', ESES: 'es-ES',
    JAJP: 'ja-JP', ZHCN: 'zh-CN', ZHHANS: 'zh-CN', ZHTW: 'zh-TW', ZHHANT: 'zh-TW', KOKR: 'ko-KR',
  }
  for (const [suffix, locale] of Object.entries(suffixAliases)) {
    if (compact.endsWith(suffix)) return locale
  }
  const match = /^[A-Z]{2}\d+([A-Z]{2})([A-Z]{2}|\d{3})$/.exec(compact)
  if (!match) return ''
  return normalizeLocale(`${match[1]}-${match[2]}`)
}

function detectAudioLocale(item, meta, id) {
  const fromId = localeFromId(id)
  const supported = new Set(['ja-JP', 'es-419', 'es-ES', 'zh-CN', 'zh-TW', 'ko-KR'])
  if (supported.has(fromId)) return fromId
  const directValues = [
    item?.audio_locale, item?.audioLocale, item?.audio_language, item?.audioLanguage,
    meta.audio_locale, meta.audioLocale, meta.audio_language, meta.audioLanguage,
  ]
  for (const value of directValues) {
    const direct = normalizeLocale(value)
    if (direct) return direct
  }
  if (fromId) return fromId
  const lists = [item?.audio_locales, item?.audioLocales, meta.audio_locales, meta.audioLocales, meta.audio_languages, meta.audioLanguages]
  const list = lists.find((value) => Array.isArray(value) && value.length) || []
  if (list.length === 1) return normalizeLocale(list[0])
  const supportedFromList = list.map(normalizeLocale).filter((locale) => supported.has(locale))
  return supportedFromList.length === 1 ? supportedFromList[0] : ''
}

function normalizeEpisode(item) {
  const meta = item?.episode_metadata || {}
  const epNum = item?.episode_number ?? meta.episode_number ?? 'Especial'
  const season = item?.season_title || meta.season_title || ''
  let series = item?.series_title || meta.series_title || item?.title || 'Anime desconocido'
  if (season && series && !series.includes(season) && !season.startsWith(series)) series += ` ${season}`
  const id = item?.id || ''
  const locale = detectAudioLocale(item, meta, id)
  const slug = item?.slug_title || meta.slug_title || ''
  return {
    id,
    series: series.trim(),
    epTitle: item?.title || '',
    epNum,
    audioLocale: locale,
    subLocales: [...new Set([...(Array.isArray(item?.subtitle_locales) ? item.subtitle_locales : []), ...(Array.isArray(meta.subtitle_locales) ? meta.subtitle_locales : [])]
      .map(normalizeLocale)
      .filter((locale) => locale && !IGNORED_LOCALES.has(locale) && isTrackedSubtitleLocale(locale)))],
    image: extractImage(item?.images),
    airTime: Date.parse(meta.episode_air_date || item?.episode_air_date || item?.premium_available_date || item?.availability_starts || '') || 0,
    link: `https://www.crunchyroll.com/watch/${id}${slug ? `/${slug}` : ''}`,
  }
}

async function fetchBrowseEpisodes() {
  const pageSize = 100
  const pageCount = Math.max(1, Math.floor(envNum('CR_PAGES', 2, 1)))
  const extraAudio = String(process.env.CR_EXTRA_AUDIO ?? 'zh-CN,ko-KR').split(',').map((x) => x.trim()).filter(Boolean)
  const allowed = new Set(['ja-JP', 'es-419', 'es-ES', ...extraAudio.map(normalizeLocale)].filter((locale) => !IGNORED_LOCALES.has(locale)))
  const seen = new Set(loadSeen())
  const browsePage = async (index) => {
    const params = { n: pageSize, start: index * pageSize, sort_by: 'newly_added', type: 'episode', locale: 'es-419' }
    try {
      return await crFetch('/content/v2/discover/browse', params, CR_BASE, BROWSE_TIMEOUT_MS)
    } catch (error) {
      if (!/CR API HTTP (?:400|403|404|405|429|5\d\d)/.test(error.message)) throw error
      console.warn(`[CR-Notify] Browse principal falló en página ${index + 1}; probando beta: ${error.message}`)
      return crFetch('/content/v2/discover/browse', params, CR_BETA, BROWSE_TIMEOUT_MS)
    }
  }
  const rows = []
  for (let index = 0; index < pageCount; index++) {
    let response
    try {
      response = await browsePage(index)
    } catch (error) {
      if (index === 0) throw error
      console.warn(`[CR-Notify] Página ${index + 1} falló; se detiene el paginado: ${error.message}`)
      break
    }
    const pageRows = Array.isArray(response?.data) ? response.data : response?.items || []
    if (!pageRows.length) break
    rows.push(...pageRows)
    if (pageRows.length < pageSize) break

    if (seen.size) {
      const hasUnseenCandidate = pageRows.some((row) => {
        const episode = normalizeEpisode(row)
        return episode.id && episode.series && (!episode.audioLocale || allowed.has(episode.audioLocale)) && !seen.has(episode.id)
      })
      if (index > 0 && !hasUnseenCandidate) {
        console.log(`[CR-Notify] Página ${index + 1} ya conocida; se detiene el paginado.`)
        break
      }
    }
  }

  const normalized = rows.map(normalizeEpisode)
  const accepted = []
  const dropped = new Map()
  const drop = (reason) => dropped.set(reason, (dropped.get(reason) || 0) + 1)
  for (const episode of normalized) {
    if (!episode.id || !episode.series) {
      drop('incompleto')
      continue
    }
    if (episode.audioLocale && !allowed.has(episode.audioLocale)) {
      drop(episode.audioLocale)
      continue
    }
    accepted.push(episode)
  }
  // Conserva el orden de Crunchyroll, igual que Rikka-TakaradaMD.
  const unique = [...new Map(accepted.map((episode) => [episode.id, episode])).values()]
  const detail = dropped.size ? ` (${[...dropped].map(([reason, count]) => `${reason}:${count}`).join(', ')})` : ''
  console.log(`[CR-Notify] Browse: ${rows.length} recibidos | ${unique.length} aceptados | ${normalized.length - accepted.length} descartados${detail}`)
  const newest = normalized.filter((episode) => episode.airTime > 0 && episode.airTime <= Date.now() + 60_000).sort((x, y) => y.airTime - x.airTime)[0]
  if (newest) {
    const minutes = Math.max(0, Math.round((Date.now() - newest.airTime) / 60000))
    console.log(`[CR-Notify] Más reciente del API: ${newest.series} Ep. ${newest.epNum} (${newest.audioLocale || '?'}) | hace ${minutes} min`)
  }
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
  const tracks = loadTrackState()
  if (!seen.length) {
    saveSeen(current.map((episode) => episode.id))
    const baseline = {}
    for (const episode of current) rememberEpisodeTracks(baseline, episode)
    saveTrackState(baseline)
    console.log(`[CR-Notify] Caché inicial sembrado con ${current.length} episodios.`)
    return []
  }
  const seenIds = new Set(seen)
  const notifications = []
  let trackUpdates = 0
  let trackStateChanged = false
  for (const episode of current) {
    if (!seenIds.has(episode.id)) {
      notifications.push({ type: 'episode', episode })
      continue
    }
    const previous = tracks[episode.id]
    if (!previous) {
      // Caché de idiomas nueva: registra lo actual sin generar avisos retroactivos.
      rememberEpisodeTracks(tracks, episode)
      trackStateChanged = true
      continue
    }
    const previousSubs = new Set(Array.isArray(previous.subLocales) ? previous.subLocales : [])
    const addedSubLocales = (episode.subLocales || []).filter((locale) => !previousSubs.has(locale))
    const addedAudioLocale = episode.audioLocale && previous.audioLocale !== episode.audioLocale
      ? episode.audioLocale
      : ''
    if (addedSubLocales.length || addedAudioLocale) {
      notifications.push({ type: 'tracks', episode, addedSubLocales, addedAudioLocale })
      trackUpdates++
    }
  }
  if (trackStateChanged) saveTrackState(tracks)
  const newEpisodes = notifications.filter((item) => item.type === 'episode').length
  console.log(`[CR-Notify] Revisión: ${current.length} válidos | ${newEpisodes} episodios nuevos | ${trackUpdates} actualización(es) de idioma | ${seen.length} registrados.`)
  return notifications.sort((x, y) => x.episode.airTime - y.episode.airTime)
}

function markSeen(id) {
  const seen = loadSeen()
  if (!seen.includes(id)) saveSeen([...seen, id])
}

function markTracksSeen(episode) {
  const tracks = loadTrackState()
  rememberEpisodeTracks(tracks, episode)
  saveTrackState(tracks)
}

const FLAGS = { 'ja-JP': '🇯🇵', 'zh-CN': '🇨🇳', 'zh-TW': '🇹🇼', 'ko-KR': '🇰🇷', 'es-419': '🇲🇽', 'es-LA': '🇲🇽', 'es-ES': '🇪🇸' }
const LOCALES = { 'ja-JP': 'Japonés', 'zh-CN': 'Chino', 'zh-TW': 'Chino (Taiwán)', 'ko-KR': 'Coreano', 'es-419': 'Latino', 'es-LA': 'Latino', 'es-ES': 'Castellano' }

function subtitleLine(episode) {
  if (['es-419', 'es-ES'].includes(episode.audioLocale)) return ''
  const subs = new Set(episode.subLocales || [])
  if (subs.has('es-419')) return '> 🇲🇽 Sub Español\n'
  if (subs.has('es-ES')) return '> 🇪🇸 Sub Español Castellano\n'
  if ([...subs].some((code) => code.startsWith('en-'))) return '> 🇺🇸 Sub English\n'
  return ''
}

function formatLocale(locale) {
  return `${FLAGS[locale] || '🌐'} ${LOCALES[locale] || locale || 'Desconocido'}`
}

function caption(episode, notification = null) {
  const flag = FLAGS[episode.audioLocale] || '🌐'
  const language = LOCALES[episode.audioLocale] || episode.audioLocale || 'Desconocido'
  const title = episode.epTitle ? `Ep. ${episode.epNum} - ${episode.epTitle}` : `Ep. ${episode.epNum}`
  const changes = []
  if (notification?.addedAudioLocale) changes.push(`Audio: ${formatLocale(notification.addedAudioLocale)}`)
  if (notification?.addedSubLocales?.length) changes.push(`Subtítulos: ${notification.addedSubLocales.map(formatLocale).join(', ')}`)
  const updateLine = changes.length ? `🆕 Nuevas pistas disponibles\n${changes.join('\n')}\n\n` : ''
  return `${updateLine}📺 ${episode.series}\n🎬 ${title}\n${flag} ${language}\n${subtitleLine(episode)}\n${episode.link}`
}

const configuredAnilistMode = String(process.env.CR_ANILIST_TITLE || 'romaji').trim().toLowerCase()
const ANILIST_TITLE_MODE = ['romaji', 'english', 'native'].includes(configuredAnilistMode) ? configuredAnilistMode : 'romaji'

function parseTitle(value) {
  const withoutParentheses = String(value || '').replace(/\([^)]*\)/gu, ' ')
  const seasonMatch = withoutParentheses.match(/\bseason\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+season\b|\btemporada\s*(\d+)\b|\bs\s*(\d+)\b/i)
  const season = seasonMatch ? Number(seasonMatch.slice(1).find(Boolean)) : null
  const fullNormalized = withoutParentheses.normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(?:dub|dubbed)\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  const withoutSeason = seasonMatch ? withoutParentheses.replace(seasonMatch[0], ' ') : withoutParentheses
  const normalized = withoutSeason.normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(?:dub|dubbed)\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { normalized, search: fullNormalized, tokens: normalized ? normalized.split(' ') : [], season }
}

function diceSimilarity(leftTokens, rightTokens) {
  const left = new Set(leftTokens)
  const right = new Set(rightTokens)
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const token of left) if (right.has(token)) overlap++
  return (2 * overlap) / (left.size + right.size)
}

function scoreAnilistCandidate(source, media) {
  const title = media?.title || {}
  const aliases = [title.romaji, title.english, title.native, ...(Array.isArray(media?.synonyms) ? media.synonyms : [])]
    .filter((candidate) => typeof candidate === 'string' && candidate.trim())
    .map(parseTitle)
  const similarity = Math.max(0, ...aliases.map((alias) => diceSimilarity(source.tokens, alias.tokens)))
  const candidateSeason = aliases.find((alias) => alias.season !== null)?.season ?? null
  let score = similarity
  if (source.season !== null) {
    if (candidateSeason === source.season) score += 0.35
    else if (candidateSeason !== null) score -= 0.5
    else if (source.season >= 2) score -= 0.55
  }
  if (source.season === 1 && candidateSeason !== null && candidateSeason >= 2) {
    score -= 0.4
  }
  return { media, similarity, score }
}

function titleHasSeason(title, season) {
  const value = String(title || '')
  return new RegExp(`(?:season\\s*${season}\\b|temporada\\s*${season}\\b|第\\s*${season}\\s*期|第${season}クール|\\b${season}(?:st|nd|rd|th)\\s+season\\b)`, 'iu').test(value)
}

function rememberAnilistMemory(key, value, ttlMs) {
  anilistMemoryCache.set(key, { value, expiresAt: Date.now() + ttlMs })
  if (anilistMemoryCache.size > ANILIST_CACHE_MAX_ENTRIES) {
    anilistMemoryCache.delete(anilistMemoryCache.keys().next().value)
  }
}

function saveAnilistDiskTitle(key, title) {
  anilistDiskCache[key] = { title, savedAt: Date.now() }
  const bounded = Object.fromEntries(Object.entries(anilistDiskCache)
    .sort((a, b) => a[1].savedAt - b[1].savedAt)
    .slice(-ANILIST_CACHE_MAX_ENTRIES))
  for (const cachedKey of Object.keys(anilistDiskCache)) delete anilistDiskCache[cachedKey]
  Object.assign(anilistDiskCache, bounded)
  try { atomicWrite(ANILIST_CACHE_PATH, anilistDiskCache) } catch (error) {
    console.warn(`[CR-Notify] No se pudo guardar caché AniList: ${error.message}`)
  }
}

async function anilistTitle(name) {
  const source = parseTitle(name)
  if (!source.normalized) return name
  const key = `v2|${ANILIST_TITLE_MODE}|${source.search}|s${source.season ?? 'x'}`
  const now = Date.now()
  const memory = anilistMemoryCache.get(key)
  if (memory && memory.expiresAt > now) return memory.value || name
  if (memory) anilistMemoryCache.delete(key)

  const disk = anilistDiskCache[key]
  if (disk?.title && Number.isFinite(disk.savedAt) && now - disk.savedAt < ANILIST_CACHE_TTL_MS) {
    rememberAnilistMemory(key, disk.title, ANILIST_CACHE_TTL_MS - (now - disk.savedAt))
    return disk.title
  }
  if (disk) delete anilistDiskCache[key]
  if (anilistInFlight.has(key)) return anilistInFlight.get(key)

  const task = (async () => {
    const query = 'query ($search: String) { Page(perPage: 10) { media(search: $search, type: ANIME, isAdult: false, format_not_in: [MUSIC], sort: SEARCH_MATCH) { title { romaji english native } synonyms } } }'
    const request = async (search) => {
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: { search } }),
        signal: AbortSignal.timeout(ANILIST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (Array.isArray(data?.errors) && data.errors.length) throw new Error(data.errors[0]?.message || 'error GraphQL')
      return data?.data?.Page?.media || []
    }
    let candidates = await request(source.search)
    if (!candidates.length && source.search !== source.normalized) candidates = await request(source.normalized)
    const ranked = candidates.map((media) => scoreAnilistCandidate(source, media))
      .filter((candidate) => candidate.similarity >= 0.5 && candidate.score >= 0.6)
      .sort((a, b) => b.score - a.score || b.similarity - a.similarity)
    const best = ranked[0]?.media
    let title = best?.title?.[ANILIST_TITLE_MODE] || best?.title?.native || best?.title?.romaji || best?.title?.english || null
    if (!title) {
      rememberAnilistMemory(key, null, ANILIST_NO_MATCH_TTL_MS)
      return name
    }
    if (source.season !== null && !titleHasSeason(title, source.season)) title += ` — Temporada ${source.season}`
    rememberAnilistMemory(key, title, ANILIST_CACHE_TTL_MS)
    saveAnilistDiskTitle(key, title)
    return title
  })().catch((error) => {
    console.warn(`[CR-Notify] AniList falló para "${name}": ${error.message}`)
    rememberAnilistMemory(key, null, ANILIST_ERROR_TTL_MS)
    return name
  }).finally(() => {
    anilistInFlight.delete(key)
  })
  anilistInFlight.set(key, task)
  return task
}

async function sendEpisode(sock, jid, episode, quoted = null, notification = null) {
  const text = caption({ ...episode, series: await anilistTitle(episode.series) }, notification)
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

function getCronIntervalMs(cfg) {
  const configuredMs = Number(cfg.intervalMs)
  if (Number.isFinite(configuredMs) && configuredMs >= 1_000) return Math.min(configuredMs, 60 * 60_000)
  const minutesRaw = cfg.minutes ?? process.env.CR_MINUTES
  if (minutesRaw === undefined || minutesRaw === '') return 60_000
  const minutes = Math.min(60, Math.max(1, Math.floor(Number(minutesRaw) || 1)))
  return minutes * 60_000
}

function formatCronInterval(intervalMs) {
  return intervalMs % 60_000 === 0
    ? `${intervalMs / 60_000} min`
    : `${Math.round(intervalMs / 1000)} s`
}

function stopCron() {
  runtime.cronGen = (runtime.cronGen || 0) + 1
  if (runtime.cronTimer) clearTimeout(runtime.cronTimer)
  runtime.cronTimer = null
}

function startCron(sock) {
  if (sock) runtime.storedSock = sock
  stopCron()
  const gen = runtime.cronGen
  const cfg = loadCfg()
  if (cfg.cronDisabled) {
    console.log('[CR-Notify] Monitoreo detenido por configuración. Usa `crstart para reanudarlo.')
    return
  }
  const intervalMs = getCronIntervalMs(cfg)
  const intervalLabel = formatCronInterval(intervalMs)
  const schedule = (waitMs) => {
    if (gen !== runtime.cronGen) return
    const timer = setTimeout(async () => {
      if (gen !== runtime.cronGen) return
      const startedAt = Date.now()
      try {
        await checkAndSend(getSock(), false)
      } catch (error) {
        console.error('[CR-Notify] Cron:', error.message)
      }
      if (gen !== runtime.cronGen) return
      schedule(Math.max(1_000, intervalMs - (Date.now() - startedAt)))
    }, waitMs)
    runtime.cronTimer = timer
    timer.unref?.()
  }
  schedule(10_000)
  console.log(`[CR-Notify] Cron activo → cada ${intervalLabel} | ${(cfg.targetJids || []).length} destino(s) configurado(s)`)
  console.log(`[CR-Notify] Auto-inicio | Destinos: ${(cfg.targetJids || []).length} | Modo: ${cfg.loggedIn ? 'Cuenta real' : 'Anónimo'} | Cron: ON`)
  console.log(`[CR-Notify] Delays → JID: ${SEND_JID_DELAY_MS}ms | Ep: ${SEND_DELAY_MS}ms | Browse: ${BROWSE_TIMEOUT_MS}ms`)
}

async function checkAndSend(sock, manual = false) {
  if (runtime.cronRunning || !sock) return 0
  const jids = loadCfg().targetJids || []
  if (!jids.length) {
    if (manual) console.log('[CR-Notify] Revisión manual omitida: no hay destinos configurados.')
    return 0
  }
  console.log(`[CR-Notify] Revisión ${manual ? 'manual' : 'programada'} iniciada | Destinos: ${jids.length}`)
  runtime.cronRunning = true
  try {
    return await withLock(async () => {
      const episodes = await fetchNew()
      if (!episodes.length) return 0
      let sent = 0
      for (const notification of episodes) {
        const episode = notification.episode
        let successful = 0
        for (const jid of jids) {
          try {
            await sendEpisode(sock, jid, episode, null, notification)
            successful++
            if (SEND_JID_DELAY_MS) await delay(SEND_JID_DELAY_MS)
          } catch (error) {
            console.error(`[CR-Notify] Error enviando ${episode.id} a ${jid}:`, error.message)
          }
        }
        if (successful === jids.length) {
          markSeen(episode.id)
          markTracksSeen(episode)
          sent++
        }
        if (SEND_DELAY_MS) await delay(SEND_DELAY_MS)
      }
      console.log(`[CR-Notify] ${sent}/${episodes.length} notificación(es) enviadas a ${jids.length} destino(s).`)
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

function isNewsletterJid(jid) {
  return typeof jid === 'string' && /^[A-Za-z0-9._-]+@newsletter$/i.test(jid)
}

function parseNewsletterTarget(raw) {
  const value = String(raw || '').trim()
  if (isNewsletterJid(value)) return { type: 'jid', key: `${value.slice(0, value.lastIndexOf('@'))}@newsletter` }
  if (/^\d+$/.test(value)) return { type: 'jid', key: `${value}@newsletter` }
  let url
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  if (!['whatsapp.com', 'www.whatsapp.com', 'wa.me', 'www.wa.me'].includes(url.hostname.toLowerCase())) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'channel') return null
  let invite
  try { invite = decodeURIComponent(parts[1]) } catch { return null }
  return /^[A-Za-z0-9_-]+$/.test(invite) ? { type: 'invite', key: invite } : null
}

async function resolveNewsletterTarget(sock, raw) {
  const target = parseNewsletterTarget(raw)
  if (!target) throw new Error('Usa un ID numérico, un JID @newsletter o un enlace whatsapp.com/channel/... o wa.me/channel/...')
  if (typeof sock.newsletterMetadata !== 'function') {
    throw new Error('Esta sesión de Baileys no ofrece newsletterMetadata; actualiza Baileys para registrar canales.')
  }
  const metadata = await sock.newsletterMetadata(target.type, target.key)
  const jid = metadata?.id || (target.type === 'jid' ? target.key : '')
  if (!isNewsletterJid(jid)) throw new Error('No pude resolver ese canal de WhatsApp.')
  return { jid: `${jid.slice(0, jid.lastIndexOf('@'))}@newsletter`, name: String(metadata?.name || '').trim() }
}

function usage(command = 'crnotify') {
  return `Uso: ${CR_PREFIX}${command} [1-50]`
}

function parseNotifyLimit(args) {
  const raw = args?.[0]
  const limit = raw === undefined ? 1 : Math.min(50, Number(raw))
  return Number.isInteger(limit) && limit >= 1 ? limit : null
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
  await msg.reply(`🔒 Sesión cerrada. Se conservaron ${cfg.targetJids.length} destino(s). El cron continuará en modo anónimo.`)
}

async function runSet({ msg, sock, isOwner }) {
  if (!(await canManageGroup(msg, sock, isOwner))) return msg.reply('⛔ Solo un administrador del grupo o el dueño puede usar este comando.')
  const cfg = loadCfg()
  if (!cfg.targetJids.includes(msg.chat)) cfg.targetJids.push(msg.chat)
  cfg.cronDisabled = false
  saveCfg(cfg)
  startCron(sock)
  return msg.reply(`✅ Grupo añadido al notificador. Total de destinos: ${cfg.targetJids.length}`)
}

async function runRemove({ msg, sock, isOwner }) {
  if (!(await canManageGroup(msg, sock, isOwner))) return msg.reply('⛔ Solo un administrador del grupo o el dueño puede usar este comando.')
  const cfg = loadCfg()
  const before = cfg.targetJids.length
  cfg.targetJids = cfg.targetJids.filter((jid) => jid !== msg.chat)
  saveCfg(cfg)
  return msg.reply(before === cfg.targetJids.length ? '⚠️ Este grupo no estaba configurado.' : `🗑️ Grupo eliminado. Quedan: ${cfg.targetJids.length}`)
}

async function runChannelAdd({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede añadir canales.')
  const inputs = (args || []).flatMap((value) => String(value).split(',').map((item) => item.trim()).filter(Boolean))
  if (!inputs.length) return msg.reply(`Uso: ${CR_PREFIX}crchanadd <ID, JID @newsletter o enlace de canal> [...]`)

  const cfg = loadCfg()
  const results = []
  let changed = false
  for (const input of inputs) {
    try {
      const { jid, name } = await resolveNewsletterTarget(sock, input)
      if (cfg.targetJids.includes(jid)) {
        results.push(`ℹ️ ${name || jid}: ya estaba configurado.`)
        continue
      }
      cfg.targetJids.push(jid)
      changed = true
      results.push(`✅ ${name ? `${name} — ` : ''}${jid} añadido.`)
    } catch (error) {
      results.push(`❌ ${input}: ${error.message}`)
    }
  }
  if (changed) {
    cfg.cronDisabled = false
    saveCfg(cfg)
    startCron(sock)
  }
  return msg.reply(`📢 Canales procesados:\n${results.join('\n')}\n\nLa cuenta de WhatsApp conectada debe ser administradora del canal para publicar.`)
}

async function runChannelRemove({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede quitar canales.')
  const inputs = (args || []).flatMap((value) => String(value).split(',').map((item) => item.trim()).filter(Boolean))
  if (!inputs.length) return msg.reply(`Uso: ${CR_PREFIX}crchanrem <ID, JID @newsletter o enlace de canal> [...]`)

  const cfg = loadCfg()
  const results = []
  let changed = false
  for (const input of inputs) {
    try {
      const target = parseNewsletterTarget(input)
      if (!target) throw new Error('Usa un ID numérico, un JID @newsletter o un enlace whatsapp.com/channel/... o wa.me/channel/...')
      const { jid } = target.type === 'jid' ? { jid: target.key } : await resolveNewsletterTarget(sock, input)
      const before = cfg.targetJids.length
      cfg.targetJids = cfg.targetJids.filter((configured) => configured !== jid)
      if (cfg.targetJids.length === before) {
        results.push(`ℹ️ ${jid}: no estaba configurado.`)
      } else {
        changed = true
        results.push(`🗑️ ${jid}: eliminado.`)
      }
    } catch (error) {
      results.push(`❌ ${input}: ${error.message}`)
    }
  }
  if (changed) saveCfg(cfg)
  return msg.reply(`📢 Canales procesados:\n${results.join('\n')}`)
}

async function runStatus({ msg }) {
  const cfg = loadCfg()
  const seen = loadSeen()
  const trackedLanguages = Object.keys(loadTrackState()).length
  const intervalLabel = formatCronInterval(getCronIntervalMs(cfg))
  const exp = cfg.tokenExp ? new Date(cfg.tokenExp).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
  const destinations = cfg.targetJids.length
    ? cfg.targetJids.map((jid, index) => `  ${index + 1}. ${isNewsletterJid(jid) ? 'Canal' : 'Grupo'} — ${jid}`).join('\n')
    : `  Ninguno — usa ${CR_PREFIX}crset o ${CR_PREFIX}crchanadd`
  return msg.reply(
    `📊 *CR-Notify Status*\n\n` +
    `🔑 Modo: *${cfg.loggedIn ? (cfg.authMode === 'web' ? 'Cuenta real (etp_rt)' : 'Cuenta real') : 'Anónimo'}*\n` +
    `⏳ Token expira: *${exp}*\n` +
    `🔁 Refresh token: *${cfg.refreshToken ? 'Sí' : 'No'}*\n` +
    `⏱️ Cron: cada *${intervalLabel}*\n` +
    `🔄 Cron activo: *${runtime.cronTimer ? 'Sí' : (cfg.cronDisabled ? 'Detenido' : 'No')}*\n` +
    `💾 Episodios registrados: *${seen.length}*\n` +
    `🈯 Episodios con idiomas registrados: *${trackedLanguages}*\n` +
    `🔐 Credenciales: *${runtime.credentialCache.source}*\n\n` +
    `🎯 *Destinos configurados (${cfg.targetJids.length}):*\n${destinations}`
  )
}

async function runList({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const limit = parseNotifyLimit(args)
  if (limit === null) return msg.reply(usage('crlist'))
  await msg.react?.('⏳').catch(() => {})
  try {
    const episodes = (await fetchLatest()).slice(0, limit)
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
  const limit = parseNotifyLimit(args)
  if (limit === null) return msg.reply(usage())
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
  if (raw === undefined) return msg.reply(`Uso: ${CR_PREFIX}crinterval <segundos>s (1s-60s) | <minutos>m (1m-60m)`)
  const value = String(raw).trim().toLowerCase()
  const intervalMatch = value.match(/^(\d+)(s|m)?$/)
  if (!intervalMatch) {
    return msg.reply('⛔ Intervalo no válido. Usa 1s-60s o 1m-60m; también se acepta un número sin sufijo como minutos.')
  }
  const amount = Number(intervalMatch[1])
  const unit = intervalMatch[2]
  let intervalMs
  let minutes
  if (unit === 's') {
    if (amount < 1 || amount > 60) {
      return msg.reply('⛔ Intervalo no válido. Usa entre 1s y 60s.')
    }
    intervalMs = amount * 1000
  } else {
    minutes = amount
    if (minutes < 1 || minutes > 60) {
      return msg.reply('⛔ Intervalo no válido. Usa entre 1m y 60m; también puedes indicar solo el número de minutos.')
    }
    intervalMs = minutes * 60_000
  }
  const cfg = loadCfg()
  if (unit === 's') {
    cfg.intervalMs = intervalMs
    delete cfg.minutes
  } else {
    cfg.minutes = minutes
    delete cfg.intervalMs
  }
  saveCfg(cfg)
  const intervalLabel = formatCronInterval(intervalMs)
  if (!cfg.cronDisabled) startCron(sock)
  return msg.reply(cfg.cronDisabled
    ? `✅ Intervalo guardado: cada ${intervalLabel}. El cron sigue detenido; usa ${CR_PREFIX}crstart para iniciarlo.`
    : `✅ Intervalo actualizado: cada ${intervalLabel}.`)
}

async function runDiag({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  await msg.react?.('⏳').catch(() => {})
  const lines = []
  try {
    await refreshCredentials()
    lines.push(`📡 Credenciales: *${runtime.credentialCache.source}*`)
    lines.push(`🔒 HTTP/TLS: *${impit ? 'impit (Chrome)' : 'fetch nativo'}*`)
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
  if (command === 'crchanadd') return runChannelAdd({ msg, sock, args, isOwner })
  if (command === 'crchanrem') return runChannelRemove({ msg, sock, args, isOwner })
  if (command === 'crstatus') return runStatus({ msg })
  if (command === 'crlist') return runList({ msg, sock, args, isOwner })
  if (command === 'crnotify') return runNotify({ msg, sock, args, isOwner })
  if (command === 'crstop') return runStop({ msg, isOwner })
  if (command === 'crstart') return runStart({ msg, sock, isOwner })
  if (command === 'crinterval') return runInterval({ msg, sock, args, isOwner })
  if (command === 'crdiag') return runDiag({ msg, isOwner })
}

export default {
  command: ['crlogin', 'crlogout', 'crset', 'crrem', 'crchanadd', 'crchanrem', 'crstatus', 'crlist', 'crnotify', 'crstop', 'crstart', 'crinterval', 'crdiag'],
  category: 'anime',
  description: 'Notificador de estrenos de Crunchyroll en grupos y canales de WhatsApp.',
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
