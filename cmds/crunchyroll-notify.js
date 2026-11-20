import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { prefix as botPrefix } from '#utils'

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url)
const TMP_DIR = path.resolve('lib/system/tmp/cr-notify')
const DB_PATH = path.join(TMP_DIR, 'crunchyroll-seen.json')
const TRACKS_PATH = path.join(TMP_DIR, 'crunchyroll-tracks.json')
const PENDING_PATH = path.join(TMP_DIR, 'crunchyroll-pending.json')
const CFG_PATH = path.join(TMP_DIR, 'crunchyroll-cfg.json')
const ANILIST_CACHE_PATH = path.join(TMP_DIR, 'anilist-titles.json')
const MAX_SEEN = 2500
const MAX_TRACKS = 2500
const MAX_PENDING_ENTRIES = 300
const MAX_DELIVERY_ATTEMPTS = 5
const MAX_ALL_FAILED_ATTEMPTS = 24
const PENDING_MAX_AGE_MS = 24 * 60 * 60_000

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
const ENV_BASIC_ANON = (process.env.CR_BASIC_ANON || '').trim()
const ENV_BASIC_AUTH = (process.env.CR_BASIC_AUTH || '').trim()
const ENV_USER_AGENT = (process.env.CR_USER_AGENT || '').trim().replace(/[\u0000-\u001f\u007f]/g, '')

const SEND_JID_DELAY_MS = envNum('CR_SEND_JID_DELAY_MS', 500)
const SEND_DELAY_MS = envNum('CR_SEND_DELAY_MS', 300)
const BROWSE_TIMEOUT_MS = envNum('CR_BROWSE_TIMEOUT_MS', 20000, 1000)
const IMAGE_TIMEOUT_MS = envNum('CR_IMAGE_TIMEOUT_MS', 10000, 1000)
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const ANILIST_TIMEOUT_MS = envNum('CR_ANILIST_TIMEOUT_MS', 4000, 1)
const ANILIST_CACHE_TTL_MS = 30 * 24 * 60 * 60_000
const ANILIST_NO_MATCH_TTL_MS = 6 * 60 * 60_000
const ANILIST_ERROR_TTL_MS = 2 * 60_000
const ANILIST_CACHE_MAX_ENTRIES = 1000
const CREDENTIAL_CACHE_MS = 6 * 60 * 60_000
const CREDENTIAL_RETRY_MS = 15 * 60_000
const COOKIE_TTL_MS = 6 * 60 * 60_000
const DEFAULT_CR_NORMAL_PAGES = 2
const DEFAULT_CR_PAGES = 5
const MAX_CR_PAGES = 15
const BROWSE_PAGE_SIZE = 100
const BROWSE_PAGE_STEP = 95
const DEEP_SCAN_INTERVAL_MS = envNum('CR_DEEP_SCAN_MINUTES', 10, 1) * 60_000

function getPrefix() {
  return botPrefix.resolvePrefix()[0] || '`'
}

fs.mkdirSync(TMP_DIR, { recursive: true })
try { fs.chmodSync(TMP_DIR, 0o700) } catch {}
for (const file of [DB_PATH, TRACKS_PATH, PENDING_PATH, CFG_PATH, ANILIST_CACHE_PATH]) {
  if (fs.existsSync(file)) {
    try { fs.chmodSync(file, 0o600) } catch {}
  }
}
try {
  for (const entry of fs.readdirSync(TMP_DIR)) {
    if (/\.tmp-\d+-[a-f0-9]+$/i.test(entry) || /^cr-img-\d+-[a-f0-9]+\.img$/i.test(entry)) {
      try { fs.unlinkSync(path.join(TMP_DIR, entry)) } catch {}
    }
  }
} catch {}

const runtime = globalThis.__rembotCrunchyrollNotify ??= {}
runtime.cronTimer ??= null
runtime.autoStartTimer ??= null
runtime.cronGen ??= 0
runtime.cronRunning ??= false
runtime.storedSock ??= null
runtime.deviceId ??= null
runtime.anonId ??= crypto.randomUUID()
runtime.anonToken ??= null
runtime.anonTokenExp ??= 0
runtime.anonTokenRefresh ??= null
runtime.accountToken ??= null
runtime.accountTokenExp ??= 0
runtime.accountTokenRefresh ??= null
runtime.cookies ??= ''
runtime.cookiesExp ??= 0
runtime.preLoginPromise ??= null
runtime.basicAnon ??= NX_BASIC
runtime.basicAuth ??= NX_BASIC
runtime.userAgent ??= NX_UA
runtime.credentialCache ??= { exp: 0, source: 'fallback', lastError: null }
runtime.credentialRefresh ??= null
runtime.lock ??= Promise.resolve()
runtime.stats ??= {}
runtime.stats.lastCheckAt ??= 0
runtime.stats.lastSuccessAt ??= 0
runtime.stats.lastError ??= null
runtime.stats.lastErrorAt ??= 0
runtime.stats.lastNewCount ??= 0
runtime.stats.lastTrackCount ??= 0
runtime.stats.consecutiveErrors ??= 0
runtime.stats.consecutiveRateLimits ??= 0
runtime.stats.lastDeepScanAt ??= 0
runtime.stats.lastCycleMs ??= 0
runtime.stats.lastBrowseMs ??= 0

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
  const target = String(url)
  if (!impit) return fetch(target, options)
  const headers = {}
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null && value !== '') headers[key] = value
  }
  return impit.fetch(target, { ...options, headers })
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
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    try { fs.chmodSync(temp, 0o600) } catch {}
    fs.renameSync(temp, file)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
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

function updateCfg(mutator) {
  const cfg = loadCfg()
  mutator(cfg)
  cfg.targetJids = [...new Set((Array.isArray(cfg.targetJids) ? cfg.targetJids : []).filter((jid) => typeof jid === 'string' && jid.trim()))]
  saveCfg(cfg)
  return cfg
}

function loadSeen() {
  const seen = loadJson(DB_PATH, [])
  return Array.isArray(seen) ? [...new Set(seen.filter((id) => typeof id === 'string' && id))] : []
}

function saveSeen(ids) {
  atomicWrite(DB_PATH, [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(-MAX_SEEN))
}

function loadTrackState() {
  const state = loadJson(TRACKS_PATH, {})
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {}
  return Object.fromEntries(Object.entries(state).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)))
}

function saveTrackState(state) {
  atomicWrite(TRACKS_PATH, Object.fromEntries(Object.entries(state).slice(-MAX_TRACKS)))
}

function loadPending() {
  const raw = loadJson(PENDING_PATH, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const now = Date.now()
  const entries = Object.entries(raw).filter(([, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const last = Number(entry.lastAttemptAt || entry.firstFailedAt || 0)
    return !last || now - last < PENDING_MAX_AGE_MS
  })
  return Object.fromEntries(entries.slice(-MAX_PENDING_ENTRIES))
}

function savePending(pending) {
  atomicWrite(PENDING_PATH, Object.fromEntries(Object.entries(pending).slice(-MAX_PENDING_ENTRIES)))
}

function rememberEpisodeTracks(state, episode) {
  const previous = state[episode.id] || {}
  const audioLocales = [...new Set([
    ...(Array.isArray(previous.audioLocales) ? previous.audioLocales : []),
    ...(previous.audioLocale ? [previous.audioLocale] : []),
    ...(episode.audioLocale ? [episode.audioLocale] : []),
  ])]
  const subLocales = [...new Set([...(Array.isArray(previous.subLocales) ? previous.subLocales : []), ...(episode.subLocales || [])])]
  const versionGuids = [...new Set([
    ...(Array.isArray(previous.versionGuids) ? previous.versionGuids : []),
    ...((Array.isArray(episode.versions) ? episode.versions : []).map((ver) => ver?.guid).filter(Boolean)),
  ])]
  delete state[episode.id]
  state[episode.id] = {
    audioLocale: episode.audioLocale || previous.audioLocale || '',
    audioLocales,
    subLocales,
    versionGuids,
  }
}

function getKnownAudioLocales(previous) {
  return new Set([
    ...(Array.isArray(previous?.audioLocales) ? previous.audioLocales : []),
    ...(previous?.audioLocale ? [previous.audioLocale] : []),
  ])
}

function backfillTrackField(state, episodeId, patch) {
  const previous = state[episodeId] || {}
  delete state[episodeId]
  state[episodeId] = {
    audioLocale: previous.audioLocale || '',
    audioLocales: Array.isArray(previous.audioLocales)
      ? previous.audioLocales
      : (previous.audioLocale ? [previous.audioLocale] : []),
    subLocales: Array.isArray(previous.subLocales) ? previous.subLocales : [],
    ...(Array.isArray(previous.versionGuids) ? { versionGuids: previous.versionGuids } : {}),
    ...patch,
  }
}

function markVersionGuidSeen(parentId, guid) {
  if (!parentId || !guid) return
  const tracks = loadTrackState()
  const previous = tracks[parentId] || {}
  const versionGuids = [...new Set([...(Array.isArray(previous.versionGuids) ? previous.versionGuids : []), guid])]
  backfillTrackField(tracks, parentId, { versionGuids })
  saveTrackState(tracks)
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

function applyFallbackCredentials() {
  runtime.basicAnon = NX_BASIC
  runtime.basicAuth = NX_BASIC
  runtime.userAgent = NX_UA
  applyOverrides()
}

function applyOverrides() {
  if (isValidBasic(ENV_BASIC_ANON)) runtime.basicAnon = ENV_BASIC_ANON
  if (isValidBasic(ENV_BASIC_AUTH)) runtime.basicAuth = ENV_BASIC_AUTH
  if (ENV_USER_AGENT) runtime.userAgent = ENV_USER_AGENT
}

function applyCredentials(authorization, client, basicAuth) {
  runtime.basicAnon = authorization
  runtime.basicAuth = basicAuth || authorization || NX_BASIC
  runtime.userAgent = `Crunchyroll/ANDROIDTV/${client.version}_${client.build} (Android 16; en-US; sdk_gphone64_x86_64)`
  applyOverrides()
}

function sessionUA(cfg) {
  return cfg?.loggedIn && cfg.authMode === 'web' ? WEB_UA : runtime.userAgent
}

function describeBasicSource(value) {
  if (value === ENV_BASIC_AUTH && ENV_BASIC_AUTH) return 'env'
  if (value === ENV_BASIC_ANON && ENV_BASIC_ANON) return 'env'
  if (value === NX_BASIC) return 'nx'
  if (value === BASIC_AUTH_FALLBACK || value === BASIC_ANON_FALLBACK) return 'fallback'
  return runtime.credentialCache.source === 'crextractor' ? 'crextractor' : 'personalizada'
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

async function refreshCredentials(force = false) {
  if (runtime.credentialRefresh) return runtime.credentialRefresh
  if (!force && runtime.credentialCache.exp && Date.now() < runtime.credentialCache.exp) return

  runtime.credentialRefresh = (async () => {
    try {
      const current = await fetchCredentials()
      applyCredentials(current.authorization, current.client, current.basicAuth)
      const hasEnvOverride = isValidBasic(ENV_BASIC_ANON) || isValidBasic(ENV_BASIC_AUTH) || Boolean(ENV_USER_AGENT)
      runtime.credentialCache = {
        exp: Date.now() + CREDENTIAL_CACHE_MS,
        source: hasEnvOverride ? 'crextractor+env' : 'crextractor',
        lastError: null,
      }
      console.log(`[CR-Notify] Credenciales actualizadas (v${current.client.version}, build ${current.client.build}).`)
    } catch (error) {
      const lastError = `crextractor: ${error.message}`
      console.warn(`[CR-Notify] Credenciales remotas no disponibles: ${error.message}. Usando fallback.`)
      applyFallbackCredentials()
      const hasEnvOverride = isValidBasic(ENV_BASIC_ANON) || isValidBasic(ENV_BASIC_AUTH) || Boolean(ENV_USER_AGENT)
      runtime.credentialCache = {
        exp: Date.now() + CREDENTIAL_RETRY_MS,
        source: hasEnvOverride ? 'env' : 'fallback',
        lastError,
      }
    }
  })().finally(() => { runtime.credentialRefresh = null })

  return runtime.credentialRefresh
}

async function preLogin(force = false) {
  if (!force && runtime.cookies && Date.now() < runtime.cookiesExp) return
  if (runtime.preLoginPromise) return runtime.preLoginPromise
  runtime.preLoginPromise = (async () => {
    await refreshCredentials()
    try {
      const response = await tlsFetch(CR_BASE, {
        headers: { 'User-Agent': runtime.userAgent },
        signal: AbortSignal.timeout(15000),
      })
      const cookies = readSetCookies(response).join('; ')
      if (cookies) {
        runtime.cookies = cookies
        runtime.cookiesExp = Date.now() + COOKIE_TTL_MS
      }
    } catch {}
  })().finally(() => { runtime.preLoginPromise = null })
  return runtime.preLoginPromise
}

async function requestAnonToken(basicHeader, userAgent) {
  const response = await tlsFetch(CR_AUTH, {
    method: 'POST',
    headers: {
      Authorization: basicHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
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
    const err = new Error(`Auth anónima HTTP ${response.status}: ${detail}`)
    err.status = response.status
    throw err
  }
  const data = await parseJsonResponse(response, '/auth/v1/token')
  if (!data?.access_token) throw new Error('Auth anónima sin access_token')
  return data
}

async function getAnonToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && runtime.anonToken && Date.now() < runtime.anonTokenExp - 30_000) {
    return runtime.anonToken
  }
  if (runtime.anonTokenRefresh) return runtime.anonTokenRefresh

  runtime.anonTokenRefresh = (async () => {
    await refreshCredentials()
    await preLogin(forceRefresh)

    const attempts = [
      { basic: runtime.basicAnon, ua: runtime.userAgent },
      ...(runtime.basicAnon !== NX_BASIC ? [{ basic: NX_BASIC, ua: NX_UA }] : []),
      ...(runtime.basicAnon !== BASIC_ANON_FALLBACK ? [{ basic: BASIC_ANON_FALLBACK, ua: CR_UA_FALLBACK }] : []),
    ]

    let lastError = null
    for (let i = 0; i < attempts.length; i++) {
      const candidate = attempts[i]
      try {
        const data = await requestAnonToken(candidate.basic, candidate.ua)
        runtime.anonToken = data.access_token
        runtime.anonTokenExp = Date.now() + (data.expires_in || 300) * 1000
        return runtime.anonToken
      } catch (error) {
        lastError = error
        if (error.status !== 401 && error.status !== 403) break
        if (i === 0) await preLogin(true)
      }
    }
    throw lastError || new Error('No se pudo obtener token anónimo')
  })().finally(() => { runtime.anonTokenRefresh = null })

  return runtime.anonTokenRefresh
}

function getDeviceId() {
  if (runtime.deviceId) return runtime.deviceId
  const cfg = loadCfg()
  if (cfg.deviceId) {
    runtime.deviceId = cfg.deviceId
    return runtime.deviceId
  }
  const generated = crypto.randomUUID()
  runtime.deviceId = generated
  updateCfg((draft) => {
    draft.deviceId ||= generated
    runtime.deviceId = draft.deviceId
  })
  return runtime.deviceId
}

async function parseJsonResponse(response, label) {
  const raw = await response.text()
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Respuesta no-JSON en ${label}: ${raw.slice(0, 120)}`)
  }
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
  const data = await parseJsonResponse(response, '/auth/v1/token')
  if (!data.access_token) throw new Error('respuesta sin access_token')
  const tokenExp = Date.now() + (data.expires_in || 300) * 1000
  updateCfg((cfg) => {
    Object.assign(cfg, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      tokenExp,
      accountId: data.account_id || null,
      loggedIn: true,
      authMode: 'web',
      etpRt,
    })
  })
  runtime.accountToken = data.access_token
  runtime.accountTokenExp = tokenExp
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
  const data = await parseJsonResponse(response, '/auth/v1/token')
  if (!data.access_token) throw new Error('respuesta sin access_token')
  const tokenExp = Date.now() + (data.expires_in || 300) * 1000
  updateCfg((cfg) => {
    Object.assign(cfg, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      tokenExp,
      accountId: data.account_id || null,
      loggedIn: true,
      authMode: 'tv',
    })
    delete cfg.etpRt
  })
  runtime.accountToken = data.access_token
  runtime.accountTokenExp = tokenExp
}

async function refreshWebToken(cfgSnapshot) {
  if (cfgSnapshot.refreshToken) {
    const response = await tlsFetch(CR_AUTH, {
      method: 'POST',
      headers: {
        Authorization: WEB_BASIC,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': WEB_UA,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfgSnapshot.refreshToken,
        scope: 'offline_access',
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) {
      const data = await parseJsonResponse(response, '/auth/v1/token')
      if (!data.access_token) throw new Error('refresh web sin access_token')
      const tokenExp = Date.now() + (data.expires_in || 300) * 1000
      updateCfg((cfg) => {
        cfg.accessToken = data.access_token
        cfg.refreshToken = data.refresh_token || cfg.refreshToken
        cfg.tokenExp = tokenExp
      })
      runtime.accountToken = data.access_token
      runtime.accountTokenExp = tokenExp
      return runtime.accountToken
    }
  }
  if (!cfgSnapshot.etpRt) throw new Error(`Sin sesión web; usa ${getPrefix()}crlogin nuevamente.`)
  await loginWithEtpRt(cfgSnapshot.etpRt)
  return runtime.accountToken
}

async function refreshAccountToken() {
  if (runtime.accountTokenRefresh) return runtime.accountTokenRefresh

  runtime.accountTokenRefresh = (async () => {
    const cfgSnapshot = loadCfg()
    if (cfgSnapshot.authMode === 'web') return refreshWebToken(cfgSnapshot)
    if (!cfgSnapshot.refreshToken) throw new Error(`Sin refresh token; usa ${getPrefix()}crlogin nuevamente.`)
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
        refresh_token: cfgSnapshot.refreshToken,
        scope: 'offline_access',
        device_id: getDeviceId(),
        device_type: 'ANDROIDTV',
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Refresh HTTP ${response.status}`)
    const data = await parseJsonResponse(response, '/auth/v1/token')
    if (!data.access_token) throw new Error('Refresh sin access_token')
    const tokenExp = Date.now() + (data.expires_in || 300) * 1000
    updateCfg((cfg) => {
      cfg.accessToken = data.access_token
      cfg.refreshToken = data.refresh_token || cfg.refreshToken
      cfg.tokenExp = tokenExp
    })
    runtime.accountToken = data.access_token
    runtime.accountTokenExp = tokenExp
    return runtime.accountToken
  })().finally(() => { runtime.accountTokenRefresh = null })

  return runtime.accountTokenRefresh
}

async function getToken() {
  const cfg = loadCfg()
  if (!cfg.loggedIn) return getAnonToken()
  if (runtime.accountToken && Date.now() < runtime.accountTokenExp - 30_000) return runtime.accountToken
  if (cfg.accessToken && cfg.tokenExp && Date.now() < cfg.tokenExp - 30_000) {
    runtime.accountToken = cfg.accessToken
    runtime.accountTokenExp = cfg.tokenExp
    return runtime.accountToken
  }
  return refreshAccountToken()
}

function parseRetryAfterMs(response, fallbackMs) {
  const raw = response.headers?.get?.('retry-after')
  if (!raw) return fallbackMs
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, Math.max(500, seconds * 1000))
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) return Math.min(10_000, Math.max(500, dateMs - Date.now()))
  return fallbackMs
}

async function crFetch(endpoint, params = {}, base = CR_BASE, timeoutMs = 20_000) {
  const url = new URL(`${base}${endpoint}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const cfg = loadCfg()
    const isWeb = cfg.loggedIn && cfg.authMode === 'web'
    const token = await getToken()
    let response
    try {
      response = await tlsFetch(String(url), {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': sessionUA(cfg),
          Accept: 'application/json',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
          ...(isWeb ? {} : { Cookie: runtime.cookies }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastError = new Error(`CR API red/timeout → ${endpoint}: ${error.message}`)
      lastError.isNetworkError = true
      if (attempt < 2) {
        await delay(1000 * (attempt + 1))
        continue
      }
      throw lastError
    }

    if (response.ok) return parseJsonResponse(response, endpoint)

    if (response.status === 401 && attempt < 2) {
      if (cfg.loggedIn) {
        runtime.accountToken = null
        runtime.accountTokenExp = 0
        updateCfg((draft) => {
          if (draft.loggedIn) {
            delete draft.accessToken
            delete draft.tokenExp
          }
        })
      } else {
        runtime.anonToken = null
        runtime.anonTokenExp = 0
      }
      runtime.cookiesExp = 0
      continue
    }

    if (response.status === 403 && attempt === 0 && !isWeb) {
      runtime.cookies = ''
      runtime.cookiesExp = 0
      await preLogin(true)
      continue
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const waitMs = response.status === 429
        ? parseRetryAfterMs(response, 1500 * (attempt + 1))
        : 1200 * (attempt + 1)
      await delay(waitMs)
      continue
    }

    const detail = (await response.text().catch(() => '')).slice(0, 160)
    const err = new Error(`CR API HTTP ${response.status} → ${endpoint}${detail ? `: ${detail}` : ''}`)
    err.status = response.status
    throw err
  }
  throw lastError || new Error(`No se pudo completar la petición → ${endpoint}`)
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
  ko: 'ko-KR', kokr: 'ko-KR', 'ko-kr': 'ko-KR',
  en: 'en-US', enus: 'en-US', 'en-us': 'en-US', engb: 'en-GB', 'en-gb': 'en-GB',
}

const LOCALE_LABELS = {
  castilian: 'es-ES', castellano: 'es-ES', 'espanol espana': 'es-ES', 'español españa': 'es-ES', 'spanish spain': 'es-ES',
  'latin spanish': 'es-419', 'latam spanish': 'es-419', 'spanish latin america': 'es-419', 'espanol latino': 'es-419', 'español latino': 'es-419',
  japanese: 'ja-JP', japonés: 'ja-JP', japones: 'ja-JP',
  chinese: 'zh-CN', chino: 'zh-CN', 'simplified chinese': 'zh-CN', 'traditional chinese': 'zh-TW',
  korean: 'ko-KR', coreano: 'ko-KR',
  english: 'en-US', inglés: 'en-US', ingles: 'en-US',
}
const IGNORED_LOCALES = new Set(['zh-TW'])
const TRACKED_SUBTITLE_LOCALES = new Set(['es-419', 'es-ES'])
const SPANISH_AUDIO_LOCALES = new Set(['es-419', 'es-ES'])

function getAllowedAudioLocales() {
  const extraAudio = String(process.env.CR_EXTRA_AUDIO ?? 'zh-CN,ko-KR').split(',').map((x) => x.trim()).filter(Boolean)
  return new Set(['ja-JP', 'es-419', 'es-ES', ...extraAudio.map(normalizeLocale)].filter((locale) => locale && !IGNORED_LOCALES.has(locale)))
}

function getConfiguredPages() {
  return Math.min(MAX_CR_PAGES, Math.max(1, Math.floor(envNum('CR_PAGES', DEFAULT_CR_PAGES, 1))))
}

function getConfiguredNormalPages() {
  const deepPages = getConfiguredPages()
  return Math.min(deepPages, Math.max(1, Math.floor(envNum('CR_NORMAL_PAGES', DEFAULT_CR_NORMAL_PAGES, 1))))
}

function isTrackedSubtitleLocale(locale) {
  return TRACKED_SUBTITLE_LOCALES.has(locale) || locale === 'en' || locale.startsWith('en-')
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

function extractVersions(item, meta) {
  const raw = [
    ...(Array.isArray(item?.versions) ? item.versions : []),
    ...(Array.isArray(meta.versions) ? meta.versions : []),
  ]
  const byGuid = new Map()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const guid = typeof entry.guid === 'string' && entry.guid.trim()
      ? entry.guid.trim()
      : (typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '')
    const audioLocale = normalizeLocale(entry.audio_locale || entry.audioLocale || entry.audio_language || '')
    if (!guid || !audioLocale || IGNORED_LOCALES.has(audioLocale)) continue
    if (!byGuid.has(guid)) {
      byGuid.set(guid, { guid, audioLocale, original: Boolean(entry.original) })
    }
  }
  return [...byGuid.values()]
}

function detectAudioLocale(item, meta, id, versions = [], allowed = getAllowedAudioLocales()) {
  const supported = new Set([...allowed, ...IGNORED_LOCALES])
  const fromId = localeFromId(id)
  if (supported.has(fromId)) return fromId

  const directValues = [
    item?.audio_locale, item?.audioLocale, item?.audio_language, item?.audioLanguage,
    meta.audio_locale, meta.audioLocale, meta.audio_language, meta.audioLanguage,
  ]
  for (const value of directValues) {
    const direct = normalizeLocale(value)
    if (direct) return direct
  }

  if (id && versions.length) {
    const matchedVersion = versions.find((ver) => ver.guid === id)
    if (matchedVersion?.audioLocale) return matchedVersion.audioLocale
  }

  if (fromId) return fromId

  const lists = [item?.audio_locales, item?.audioLocales, meta.audio_locales, meta.audioLocales, meta.audio_languages, meta.audioLanguages]
  const list = lists.find((value) => Array.isArray(value) && value.length) || []
  const normalizedList = [...new Set(list.map(normalizeLocale).filter(Boolean))]
  if (normalizedList.length === 1) return normalizedList[0]
  if (normalizedList.length > 1) {
    const supportedFromList = normalizedList.filter((locale) => supported.has(locale))
    if (supportedFromList.length === 1) return supportedFromList[0]
    // Si ninguno de los idiomas en la lista está permitido, devuelve uno para descartarlo
    // en lugar de dejarlo pasar como idioma vacío.
    if (supportedFromList.length === 0) return normalizedList[0]
  }
  return ''
}

function cleanSeasonLabel(season) {
  return String(season || '')
    .replace(/\s*\([^)]*\b(?:dub|dubbed|doblaje|doblado)\b[^)]*\)/giu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSeriesName(rawSeries, rawSeason) {
  const base = String(rawSeries || '').trim()
  const season = cleanSeasonLabel(rawSeason)
  if (!base) return season || 'Anime desconocido'
  if (!season) return base
  const baseLower = base.toLowerCase()
  const seasonLower = season.toLowerCase()
  if (baseLower === seasonLower || baseLower.includes(seasonLower)) return base
  if (seasonLower.startsWith(baseLower)) return season
  return `${base} ${season}`
}

function parseEpisodeNumber(item, meta) {
  const numeric = item?.episode_number ?? meta.episode_number
  if (numeric !== undefined && numeric !== null && numeric !== '') return numeric
  const label = String(item?.episode ?? meta.episode ?? '').trim()
  return label || 'Especial'
}

function normalizeEpisode(item, allowed = getAllowedAudioLocales()) {
  const meta = item?.episode_metadata || {}
  const epNum = parseEpisodeNumber(item, meta)
  const season = item?.season_title || meta.season_title || ''
  const rawSeries = item?.series_title || meta.series_title || item?.title || ''
  const series = buildSeriesName(rawSeries, season)
  const id = typeof item?.id === 'string' ? item.id.trim() : ''
  const versions = extractVersions(item, meta)
  const locale = detectAudioLocale(item, meta, id, versions, allowed)
  const slug = item?.slug_title || meta.slug_title || ''
  const dateCandidates = [
    meta.episode_air_date,
    item?.episode_air_date,
    meta.upload_date,
    item?.upload_date,
    meta.premium_available_date,
    item?.premium_available_date,
    meta.availability_starts,
    item?.availability_starts,
  ]
  let airTime = 0
  for (const candidate of dateCandidates) {
    const parsed = Date.parse(candidate || '')
    if (Number.isFinite(parsed) && parsed > 0) {
      airTime = parsed
      break
    }
  }
  return {
    id,
    series: series.trim(),
    epTitle: item?.title || '',
    epNum,
    audioLocale: locale,
    subLocales: [...new Set([...(Array.isArray(item?.subtitle_locales) ? item.subtitle_locales : []), ...(Array.isArray(meta.subtitle_locales) ? meta.subtitle_locales : [])]
      .map(normalizeLocale)
      .filter((code) => code && !IGNORED_LOCALES.has(code) && isTrackedSubtitleLocale(code)))],
    versions,
    image: extractImage(item?.images),
    airTime,
    slug,
    link: `https://www.crunchyroll.com/watch/${id}${slug ? `/${slug}` : ''}`,
  }
}

function mergeEpisodes(existing, incoming) {
  const versionsByGuid = new Map()
  for (const ver of [...(existing.versions || []), ...(incoming.versions || [])]) {
    if (ver?.guid && !versionsByGuid.has(ver.guid)) versionsByGuid.set(ver.guid, ver)
  }
  return {
    ...existing,
    audioLocale: existing.audioLocale || incoming.audioLocale,
    subLocales: [...new Set([...(existing.subLocales || []), ...(incoming.subLocales || [])])],
    versions: [...versionsByGuid.values()],
    image: existing.image || incoming.image,
    airTime: existing.airTime || incoming.airTime,
  }
}

function buildVersionEpisode(parent, version) {
  const slug = parent.slug || ''
  return {
    ...parent,
    id: version.guid,
    audioLocale: version.audioLocale,
    subLocales: SPANISH_AUDIO_LOCALES.has(version.audioLocale) ? [] : [...(parent.subLocales || [])],
    versions: [{ guid: version.guid, audioLocale: version.audioLocale, original: Boolean(version.original) }],
    link: `https://www.crunchyroll.com/watch/${version.guid}${slug ? `/${slug}` : ''}`,
  }
}

function hasPendingTrackOrVersionChange(episode, trackState, seenSet, allowed) {
  if (!trackState) return false
  const previous = trackState[episode.id]
  if (!previous) return false

  const knownAudio = getKnownAudioLocales(previous)
  if (episode.audioLocale && !knownAudio.has(episode.audioLocale)) return true

  if (!SPANISH_AUDIO_LOCALES.has(episode.audioLocale)) {
    const previousSubs = new Set(Array.isArray(previous.subLocales) ? previous.subLocales : [])
    if ((episode.subLocales || []).some((locale) => !previousSubs.has(locale))) return true
  }

  if (Array.isArray(previous.versionGuids) && Array.isArray(episode.versions)) {
    const previousVersions = new Set(previous.versionGuids)
    for (const ver of episode.versions) {
      if (ver.guid && ver.guid !== episode.id && ver.audioLocale && allowed.has(ver.audioLocale)) {
        if (!previousVersions.has(ver.guid) && (!seenSet || !seenSet.has(ver.guid))) return true
      }
    }
  }
  return false
}

async function fetchBrowseEpisodes(options = {}) {
  const browseStartedAt = Date.now()
  const deepScan = Boolean(options.deepScan)
  const defaultPages = deepScan ? getConfiguredPages() : getConfiguredNormalPages()
  const maxPages = Math.max(1, Math.min(MAX_CR_PAGES, options.maxPages || defaultPages))
  const minPages = Math.max(1, Math.min(maxPages, options.minPages ?? Math.min(maxPages, 2)))
  const limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 0
  const allowed = getAllowedAudioLocales()
  const seenSet = options.seenSet instanceof Set ? options.seenSet : new Set(loadSeen())
  const trackState = options.trackState ?? null

  const browsePage = async (index, start) => {
    const params = { n: BROWSE_PAGE_SIZE, start, sort_by: 'newly_added', type: 'episode', locale: 'es-419' }
    try {
      return await crFetch('/content/v2/discover/browse', params, CR_BASE, BROWSE_TIMEOUT_MS)
    } catch (error) {
      const retryableHttp = /CR API HTTP (?:400|403|404|405|429|5\d\d)/.test(error.message)
      if (!retryableHttp && !error.isNetworkError) throw error
      console.warn(`[CR-Notify] Browse principal falló en página ${index + 1}; probando beta: ${error.message}`)
      return crFetch('/content/v2/discover/browse', params, CR_BETA, BROWSE_TIMEOUT_MS)
    }
  }

  const acceptedById = new Map()
  const seenRawIds = new Set()
  const dropped = new Map()
  const drop = (reason) => dropped.set(reason, (dropped.get(reason) || 0) + 1)
  let totalRaw = 0
  let totalDropped = 0
  let pagesFetched = 0
  let newestCandidate = null
  const nowLimit = Date.now() + 60_000

  for (let index = 0; index < maxPages; index++) {
    const start = index === 0 ? 0 : index * BROWSE_PAGE_STEP
    let response
    try {
      response = await browsePage(index, start)
    } catch (error) {
      if (index === 0) throw error
      console.warn(`[CR-Notify] Página ${index + 1} falló; se detiene el paginado: ${error.message}`)
      break
    }
    pagesFetched++
    const pageRows = Array.isArray(response?.data) ? response.data : response?.items || []
    if (!pageRows.length) break
    totalRaw += pageRows.length

    let unseenAcceptedInPage = 0
    let seenAcceptedInPage = 0
    let trackChangesInPage = 0

    for (const row of pageRows) {
      const episode = normalizeEpisode(row, allowed)
      if (episode.airTime > 0 && episode.airTime <= nowLimit && (!newestCandidate || episode.airTime > newestCandidate.airTime)) {
        newestCandidate = episode
      }
      if (!episode.id || !episode.series) {
        drop('incompleto')
        totalDropped++
        continue
      }
      if (episode.audioLocale && !allowed.has(episode.audioLocale)) {
        if (!seenRawIds.has(episode.id)) {
          seenRawIds.add(episode.id)
          drop(episode.audioLocale)
          totalDropped++
        }
        continue
      }
      seenRawIds.add(episode.id)
      if (acceptedById.has(episode.id)) {
        acceptedById.set(episode.id, mergeEpisodes(acceptedById.get(episode.id), episode))
        continue
      }
      acceptedById.set(episode.id, episode)
      if (seenSet.size) {
        if (!seenSet.has(episode.id)) {
          unseenAcceptedInPage++
        } else {
          seenAcceptedInPage++
          if (hasPendingTrackOrVersionChange(episode, trackState, seenSet, allowed)) {
            trackChangesInPage++
          }
        }
      }
    }

    if (pageRows.length < BROWSE_PAGE_SIZE) break
    if (limit > 0 && acceptedById.size >= limit) break

    // Solo detener temprano cuando ya cubrimos minPages, la página tiene episodios válidos
    // conocidos (no es puro relleno de doblajes descartados) y no hubo nuevos ni cambios de pistas.
    if (!deepScan && seenSet.size && index + 1 >= minPages && unseenAcceptedInPage === 0 && trackChangesInPage === 0 && seenAcceptedInPage > 0) {
      console.log(`[CR-Notify] Página ${index + 1} ya conocida (${seenAcceptedInPage} vistos); se detiene el paginado.`)
      break
    }
  }

  // Conserva el orden de Crunchyroll, igual que Rikka-TakaradaMD.
  const unique = [...acceptedById.values()]
  const browseMs = Date.now() - browseStartedAt
  runtime.stats.lastBrowseMs = browseMs
  const detail = dropped.size ? ` (${[...dropped].map(([reason, count]) => `${reason}:${count}`).join(', ')})` : ''
  console.log(`[CR-Notify] Browse (${pagesFetched}p${deepScan ? ' profundo' : ''}, ${browseMs}ms): ${totalRaw} recibidos | ${unique.length} aceptados | ${totalDropped} descartados${detail}`)
  if (newestCandidate) {
    const minutes = Math.max(0, Math.round((Date.now() - newestCandidate.airTime) / 60000))
    console.log(`[CR-Notify] Más reciente del API: ${newestCandidate.series} Ep. ${newestCandidate.epNum} (${newestCandidate.audioLocale || '?'}) | hace ${minutes} min`)
  }
  return unique
}

async function fetchLatest(options = {}) {
  return fetchBrowseEpisodes(options)
}

function numericEpNum(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compareNotifications(left, right) {
  const leftTime = left.episode.airTime || 0
  const rightTime = right.episode.airTime || 0
  if (leftTime > 0 && rightTime > 0 && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  if (left.episode.series === right.episode.series) {
    const leftEp = numericEpNum(left.episode.epNum)
    const rightEp = numericEpNum(right.episode.epNum)
    if (leftEp !== null && rightEp !== null && leftEp !== rightEp) {
      return leftEp - rightEp
    }
  }
  // Empate: el índice mayor apareció más abajo (más antiguo) en el feed newest-first.
  return (right.browseIndex ?? 0) - (left.browseIndex ?? 0)
}

function detectNotifications(current, seen, tracks, allowed = getAllowedAudioLocales()) {
  const seenIds = new Set(seen)
  const topLevelIds = new Set(current.map((episode) => episode.id))
  const emittedVersionGuids = new Set()
  const notifications = []
  let trackUpdates = 0
  let versionUpdates = 0
  let trackStateChanged = false

  for (let browseIndex = 0; browseIndex < current.length; browseIndex++) {
    const episode = current[browseIndex]
    if (!seenIds.has(episode.id)) {
      notifications.push({
        type: 'episode',
        key: `ep:${episode.id}`,
        episode,
        browseIndex,
      })
      continue
    }

    const previous = tracks[episode.id]
    if (!previous) {
      // Caché de idiomas nueva: registra lo actual sin generar avisos retroactivos.
      rememberEpisodeTracks(tracks, episode)
      trackStateChanged = true
      continue
    }

    // Detecta doblajes nuevos agregados dentro de episode_metadata.versions sin avisos retroactivos.
    if (!Array.isArray(previous.versionGuids)) {
      const initialGuids = [...new Set((Array.isArray(episode.versions) ? episode.versions : []).map((ver) => ver?.guid).filter(Boolean))]
      backfillTrackField(tracks, episode.id, { versionGuids: initialGuids })
      trackStateChanged = true
    } else if (Array.isArray(episode.versions) && episode.versions.length) {
      const previousVersions = new Set(previous.versionGuids)
      for (const ver of episode.versions) {
        if (!ver.guid || ver.guid === episode.id || !ver.audioLocale || !allowed.has(ver.audioLocale)) continue
        if (seenIds.has(ver.guid) || previousVersions.has(ver.guid) || topLevelIds.has(ver.guid) || emittedVersionGuids.has(ver.guid)) continue
        emittedVersionGuids.add(ver.guid)
        const versionEpisode = buildVersionEpisode(episode, ver)
        notifications.push({
          type: 'episode',
          key: `ver:${episode.id}:${ver.guid}`,
          episode: versionEpisode,
          parentId: episode.id,
          versionGuid: ver.guid,
          browseIndex,
        })
        versionUpdates++
      }
    }

    const previousSubs = new Set(Array.isArray(previous.subLocales) ? previous.subLocales : [])
    const newSubs = (episode.subLocales || []).filter((locale) => !previousSubs.has(locale))
    const isSpanishDub = SPANISH_AUDIO_LOCALES.has(episode.audioLocale)
    const addedSubLocales = isSpanishDub ? [] : newSubs
    const knownAudio = getKnownAudioLocales(previous)
    const addedAudioLocale = episode.audioLocale && !knownAudio.has(episode.audioLocale)
      ? episode.audioLocale
      : ''

    if (isSpanishDub && newSubs.length && !addedAudioLocale) {
      const mergedSubs = [...new Set([...previousSubs, ...newSubs])]
      backfillTrackField(tracks, episode.id, { subLocales: mergedSubs })
      trackStateChanged = true
    }

    if (addedSubLocales.length || addedAudioLocale) {
      const key = `trk:${episode.id}:${addedAudioLocale}:${[...addedSubLocales].sort().join(',')}`
      notifications.push({
        type: 'tracks',
        key,
        episode,
        addedSubLocales,
        addedAudioLocale,
        browseIndex,
      })
      trackUpdates++
    }
  }

  return {
    notifications: notifications.sort(compareNotifications),
    trackUpdates,
    versionUpdates,
    trackStateChanged,
  }
}

async function fetchNew({ deepScan = false } = {}) {
  const seen = loadSeen()
  const tracks = loadTrackState()
  const isSeeding = !seen.length
  const allowed = getAllowedAudioLocales()
  const current = await fetchLatest({
    deepScan: deepScan || isSeeding,
    seenSet: new Set(seen),
    trackState: tracks,
  })
  if (!current.length) {
    console.log('[CR-Notify] Revisión: no se encontraron episodios válidos.')
    return []
  }

  if (isSeeding) {
    // Guardar de más antiguo a más nuevo para que slice(-MAX_SEEN) nunca expulse los más recientes.
    const chronological = [...current].reverse()
    const seedIds = []
    const baseline = {}
    for (const episode of chronological) {
      seedIds.push(episode.id)
      for (const ver of episode.versions || []) {
        if (ver?.guid && ver.audioLocale && allowed.has(ver.audioLocale)) seedIds.push(ver.guid)
      }
      rememberEpisodeTracks(baseline, episode)
    }
    saveSeen(seedIds)
    saveTrackState(baseline)
    savePending({})
    console.log(`[CR-Notify] Caché inicial sembrado con ${current.length} episodios (${seedIds.length} IDs).`)
    return []
  }

  const { notifications, trackUpdates, versionUpdates, trackStateChanged } = detectNotifications(current, seen, tracks, allowed)
  if (trackStateChanged) saveTrackState(tracks)
  const newEpisodes = notifications.filter((item) => item.type === 'episode').length
  runtime.stats.lastNewCount = newEpisodes
  runtime.stats.lastTrackCount = trackUpdates
  console.log(`[CR-Notify] Revisión: ${current.length} válidos | ${newEpisodes} episodios nuevos (${versionUpdates} por versión) | ${trackUpdates} actualización(es) de idioma | ${seen.length} registrados.`)
  return notifications
}

function markSeen(id) {
  if (!id) return
  const seen = loadSeen()
  if (!seen.includes(id)) saveSeen([...seen, id])
}

function markTracksSeen(episode) {
  if (!episode?.id) return
  const tracks = loadTrackState()
  rememberEpisodeTracks(tracks, episode)
  saveTrackState(tracks)
}

function commitNotificationState(notification) {
  markSeen(notification.episode.id)
  if (notification.parentId && notification.versionGuid) {
    markVersionGuidSeen(notification.parentId, notification.versionGuid)
  }
  if (notification.type === 'tracks') {
    const tracks = loadTrackState()
    const previous = tracks[notification.episode.id] || {}
    const audioLocales = [...new Set([
      ...(Array.isArray(previous.audioLocales) ? previous.audioLocales : []),
      ...(previous.audioLocale ? [previous.audioLocale] : []),
      ...(notification.addedAudioLocale ? [notification.addedAudioLocale] : []),
    ])]
    const subLocales = [...new Set([
      ...(Array.isArray(previous.subLocales) ? previous.subLocales : []),
      ...(notification.addedSubLocales || []),
    ])]
    backfillTrackField(tracks, notification.episode.id, {
      audioLocale: notification.addedAudioLocale || previous.audioLocale || notification.episode.audioLocale || '',
      audioLocales,
      subLocales,
    })
    saveTrackState(tracks)
    return
  }
  markTracksSeen(notification.episode)
}

const FLAGS = {
  'ja-JP': '🇯🇵',
  'zh-CN': '🇨🇳',
  'zh-TW': '🇹🇼',
  'ko-KR': '🇰🇷',
  'es-419': '🇲🇽',
  'es-LA': '🇲🇽',
  'es-ES': '🇪🇸',
  'en-US': '🇺🇸',
  'en-GB': '🇬🇧',
  en: '🇺🇸',
}
const LOCALES = {
  'ja-JP': 'Japonés',
  'zh-CN': 'Chino',
  'zh-TW': 'Chino (Taiwán)',
  'ko-KR': 'Coreano',
  'es-419': 'Latino',
  'es-LA': 'Latino',
  'es-ES': 'Castellano',
  'en-US': 'Inglés',
  'en-GB': 'Inglés',
  en: 'Inglés',
}

function subtitleLine(episode) {
  if (SPANISH_AUDIO_LOCALES.has(episode.audioLocale)) return ''
  const subs = new Set(episode.subLocales || [])
  if (subs.has('es-419')) return '> 🇲🇽 Sub Español\n'
  if (subs.has('es-ES')) return '> 🇪🇸 Sub Español Castellano\n'
  if ([...subs].some((code) => code === 'en' || code.startsWith('en-'))) return '> 🇺🇸 Sub English\n'
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
  if ((source.season === null || source.season === 1) && candidateSeason !== null && candidateSeason >= 2) {
    score -= 0.4
  }
  return { media, similarity, score }
}

function titleHasSeason(title, season) {
  const value = String(title || '').trim()
  if (new RegExp(`(?:season\\s*${season}\\b|temporada\\s*${season}\\b|第\\s*${season}\\s*期|第${season}クール|\\b${season}(?:st|nd|rd|th)\\s+season\\b|\\bs\\s*${season}\\b)`, 'iu').test(value)) {
    return true
  }
  if (season >= 2 && new RegExp(`(?:^|\\s)${season}$`, 'u').test(value)) return true
  const roman = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X' }[season]
  if (roman && new RegExp(`(?:^|\\s)${roman}$`, 'u').test(value)) return true
  return false
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
    const rankCandidates = (list) => list.map((media) => scoreAnilistCandidate(source, media))
      .filter((candidate) => candidate.similarity >= 0.5 && candidate.score >= 0.6)
      .sort((a, b) => b.score - a.score || b.similarity - a.similarity)

    const candidates = await request(source.search)
    let ranked = rankCandidates(candidates)
    if (!ranked.length && source.search !== source.normalized) {
      ranked = rankCandidates(await request(source.normalized))
    }
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

async function fetchImageBuffer(url) {
  if (!url) return null
  try {
    const response = await tlsFetch(url, {
      headers: { Accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const length = Number(response.headers?.get?.('content-length') || 0)
    if (length > IMAGE_MAX_BYTES) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.length > 0 && buffer.length <= IMAGE_MAX_BYTES ? buffer : null
  } catch {
    return null
  }
}

function writeTempImage(buffer) {
  if (!buffer?.length) return null
  const filePath = path.join(TMP_DIR, `cr-img-${process.pid}-${crypto.randomUUID().slice(0, 8)}.img`)
  try {
    fs.writeFileSync(filePath, buffer)
    try { fs.chmodSync(filePath, 0o600) } catch {}
    return filePath
  } catch {
    try { fs.unlinkSync(filePath) } catch {}
    return null
  }
}

function formatAgeMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${String(mins % 60).padStart(2, '0')}m`
}

async function prepareEpisodePayload(episode, notification = null) {
  const prepStartedAt = Date.now()
  const [resolvedSeries, imageBuffer] = await Promise.all([
    anilistTitle(episode.series),
    episode.image ? fetchImageBuffer(episode.image) : Promise.resolve(null),
  ])
  const imageFilePath = imageBuffer ? writeTempImage(imageBuffer) : null
  let cleaned = false
  return {
    text: caption({ ...episode, series: resolvedSeries }, notification),
    imageBuffer,
    imageFilePath,
    imageUrl: episode.image || '',
    // Baileys cifra medios para grupos/chats y sube crudo para canales (@newsletter);
    // usar cachés separadas evita cruzar formatos y reutiliza una sola subida por tipo.
    groupMediaCache: new Map(),
    newsletterMediaCache: new Map(),
    prepMs: Date.now() - prepStartedAt,
    cleanup() {
      if (cleaned) return
      cleaned = true
      if (imageFilePath) {
        try { fs.unlinkSync(imageFilePath) } catch {}
      }
    },
  }
}

async function deliverPayload(sock, jid, payload, quoted = null) {
  const baseOptions = quoted ? { quoted } : {}
  const mediaCache = isNewsletterJid(jid) ? payload.newsletterMediaCache : payload.groupMediaCache
  const mediaOptions = mediaCache ? { ...baseOptions, mediaCache } : baseOptions

  if (payload.imageFilePath) {
    try {
      await sock.sendMessage(jid, { image: { url: payload.imageFilePath }, caption: payload.text }, mediaOptions)
      return
    } catch (error) {
      console.warn(`[CR-Notify] Envío de imagen (caché local) falló para ${jid}; probando respaldo: ${error.message}`)
    }
  }
  if (payload.imageBuffer) {
    try {
      await sock.sendMessage(jid, { image: payload.imageBuffer, caption: payload.text }, baseOptions)
      return
    } catch (error) {
      console.warn(`[CR-Notify] Envío de imagen (buffer) falló para ${jid}; probando respaldo: ${error.message}`)
    }
  }
  if (payload.imageUrl) {
    try {
      await sock.sendMessage(jid, { image: { url: payload.imageUrl }, caption: payload.text }, mediaOptions)
      return
    } catch (error) {
      console.warn(`[CR-Notify] Envío de imagen (URL) falló para ${jid}; enviando solo texto: ${error.message}`)
    }
  }
  await sock.sendMessage(jid, { text: payload.text }, baseOptions)
}

async function sendEpisode(sock, jid, episode, quoted = null, notification = null) {
  const payload = await prepareEpisodePayload(episode, notification)
  try {
    await deliverPayload(sock, jid, payload, quoted)
  } finally {
    payload.cleanup()
  }
}

async function withLock(fn) {
  const previous = runtime.lock
  let release
  runtime.lock = new Promise((resolve) => { release = resolve })
  await previous
  try { return await fn() } finally { release() }
}

function getSock(fallback) {
  return global.sock || fallback || runtime.storedSock || null
}

function isSockReady(sock) {
  if (!sock || typeof sock.sendMessage !== 'function') return false
  if (sock.ws?.isClosed === true || sock.ws?.isClosing === true || sock.ws?.isConnecting === true) return false
  if (typeof sock.ws?.readyState === 'number' && sock.ws.readyState !== 1) return false
  if ('user' in sock && !sock.user?.id && !sock.authState?.creds?.me?.id) return false
  return true
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
    console.log(`[CR-Notify] Monitoreo detenido por configuración. Usa ${getPrefix()}crstart para reanudarlo.`)
    return
  }
  const intervalMs = getCronIntervalMs(cfg)
  const intervalLabel = formatCronInterval(intervalMs)
  const schedule = (waitMs) => {
    if (gen !== runtime.cronGen) return
    const timer = setTimeout(async () => {
      if (gen !== runtime.cronGen) return
      if (!fs.existsSync(CURRENT_FILE_PATH)) {
        stopCron()
        return
      }
      const startedAt = Date.now()
      let rateLimited = false
      let skippedReason = null
      try {
        const result = await checkAndSend(getSock(), false)
        skippedReason = result?.skipped || null
      } catch (error) {
        rateLimited = error?.status === 429 || /HTTP 429/.test(error?.message || '')
        runtime.stats.lastError = error.message
        runtime.stats.lastErrorAt = Date.now()
        runtime.stats.consecutiveErrors = (runtime.stats.consecutiveErrors || 0) + 1
        if (rateLimited) runtime.stats.consecutiveRateLimits = (runtime.stats.consecutiveRateLimits || 0) + 1
        console.error('[CR-Notify] Cron:', error.message)
      }
      if (gen !== runtime.cronGen) return
      let nextWaitMs = skippedReason === 'disconnected'
        ? Math.min(intervalMs, 15_000)
        : Math.max(1_000, intervalMs - (Date.now() - startedAt))
      if (rateLimited) {
        const backoffMs = Math.min(10 * 60_000, 60_000 * 2 ** Math.min((runtime.stats.consecutiveRateLimits || 1) - 1, 3))
        nextWaitMs = Math.max(nextWaitMs, backoffMs)
        console.warn(`[CR-Notify] Rate limit (429); pausando ${Math.round(nextWaitMs / 1000)}s antes de reintentar.`)
      }
      schedule(nextWaitMs)
    }, waitMs)
    runtime.cronTimer = timer
    timer.unref?.()
  }
  schedule(10_000)
  console.log(`[CR-Notify] Cron activo → cada ${intervalLabel} | ${(cfg.targetJids || []).length} destino(s) configurado(s) | ${getConfiguredNormalPages()} pág. normal / ${getConfiguredPages()} pág. profundo`)
  console.log(`[CR-Notify] Auto-inicio | Destinos: ${(cfg.targetJids || []).length} | Modo: ${cfg.loggedIn ? 'Cuenta real' : 'Anónimo'} | Cron: ON`)
  console.log(`[CR-Notify] Delays → JID: ${SEND_JID_DELAY_MS}ms | Ep: ${SEND_DELAY_MS}ms | Browse: ${BROWSE_TIMEOUT_MS}ms`)
}

async function checkAndSend(sock, manual = false) {
  const activeSock = getSock(sock)
  if (runtime.cronRunning) {
    if (manual) console.log('[CR-Notify] Revisión manual omitida: ya hay una revisión en curso.')
    return { sent: 0, total: 0, skipped: 'running' }
  }
  if (!isSockReady(activeSock)) {
    if (manual) console.log('[CR-Notify] Revisión manual omitida: WhatsApp aún no está listo.')
    return { sent: 0, total: 0, skipped: 'disconnected' }
  }
  const initialJids = loadCfg().targetJids || []
  if (!initialJids.length) {
    if (manual) console.log('[CR-Notify] Revisión manual omitida: no hay destinos configurados.')
    return { sent: 0, total: 0, skipped: 'no_targets' }
  }
  console.log(`[CR-Notify] Revisión ${manual ? 'manual' : 'programada'} iniciada | Destinos: ${initialJids.length}`)
  runtime.cronRunning = true
  const cycleStartedAt = Date.now()
  runtime.stats.lastCheckAt = cycleStartedAt
  try {
    return await withLock(async () => {
      const deepScan = manual || (Date.now() - (runtime.stats.lastDeepScanAt || 0) >= DEEP_SCAN_INTERVAL_MS)
      const notifications = await fetchNew({ deepScan })
      const detectedAt = Date.now()
      const detectMs = detectedAt - cycleStartedAt
      runtime.stats.lastSuccessAt = detectedAt
      runtime.stats.lastError = null
      runtime.stats.consecutiveErrors = 0
      runtime.stats.consecutiveRateLimits = 0
      if (deepScan) runtime.stats.lastDeepScanAt = detectedAt

      if (!notifications.length) {
        runtime.stats.lastCycleMs = detectMs
        console.log(`[CR-Notify] Revisión sin novedades en ${detectMs}ms.`)
        return { sent: 0, total: 0, skipped: null, detectMs, totalMs: detectMs }
      }

      const pending = loadPending()
      let sent = 0
      let partial = 0

      for (let notifIndex = 0; notifIndex < notifications.length; notifIndex++) {
        const notification = notifications[notifIndex]
        const currentJids = loadCfg().targetJids || []
        if (!currentJids.length) break

        const episode = notification.episode
        const existingPending = pending[notification.key] || {
          deliveredJids: [],
          attempts: 0,
          firstFailedAt: 0,
          lastAttemptAt: 0,
        }
        const deliveredSet = new Set(Array.isArray(existingPending.deliveredJids) ? existingPending.deliveredJids : [])
        const remainingJids = currentJids.filter((jid) => !deliveredSet.has(jid))

        if (remainingJids.length) {
          const payload = await prepareEpisodePayload(episode, notification)
          const deliverStartedAt = Date.now()
          let sentNow = 0
          try {
            for (let i = 0; i < remainingJids.length; i++) {
              const jid = remainingJids[i]
              const liveSock = getSock(activeSock)
              try {
                if (!isSockReady(liveSock)) throw new Error('Sesión de WhatsApp desconectada')
                await deliverPayload(liveSock, jid, payload)
                deliveredSet.add(jid)
                sentNow++
                if (i < remainingJids.length - 1) {
                  pending[notification.key] = {
                    deliveredJids: [...deliveredSet],
                    attempts: existingPending.attempts || 0,
                    firstFailedAt: existingPending.firstFailedAt || Date.now(),
                    lastAttemptAt: Date.now(),
                  }
                  savePending(pending)
                  if (SEND_JID_DELAY_MS) await delay(SEND_JID_DELAY_MS)
                }
              } catch (error) {
                console.error(`[CR-Notify] Error enviando ${episode.id} a ${jid}:`, error.message)
              }
            }
          } finally {
            payload.cleanup()
          }
          const deliverMs = Date.now() - deliverStartedAt
          const ageLabel = episode.airTime > 0 ? formatAgeMs(Math.max(0, detectedAt - episode.airTime)) : '—'
          console.log(`[CR-Notify] Envío ${episode.id} (${episode.series} Ep. ${episode.epNum}) | edad API: ${ageLabel} | prep: ${payload.prepMs}ms | envío (${sentNow}/${remainingJids.length}): ${deliverMs}ms`)
        }

        const failedJids = currentJids.filter((jid) => !deliveredSet.has(jid))
        if (failedJids.length === 0) {
          commitNotificationState(notification)
          if (pending[notification.key]) {
            delete pending[notification.key]
            savePending(pending)
          }
          sent++
        } else {
          const anyDelivered = currentJids.some((jid) => deliveredSet.has(jid))
          const attempts = (existingPending.attempts || 0) + 1
          const maxAttempts = anyDelivered ? MAX_DELIVERY_ATTEMPTS : MAX_ALL_FAILED_ATTEMPTS
          if (attempts >= maxAttempts) {
            console.warn(`[CR-Notify] Descartando reintentos de ${episode.id} tras ${attempts} intentos; falló en: ${failedJids.join(', ')}`)
            commitNotificationState(notification)
            delete pending[notification.key]
            savePending(pending)
            if (anyDelivered) sent++
          } else {
            pending[notification.key] = {
              deliveredJids: [...deliveredSet],
              attempts,
              firstFailedAt: existingPending.firstFailedAt || Date.now(),
              lastAttemptAt: Date.now(),
            }
            savePending(pending)
            partial++
          }
        }
        if (SEND_DELAY_MS && notifIndex < notifications.length - 1) await delay(SEND_DELAY_MS)
      }

      const totalMs = Date.now() - cycleStartedAt
      const sendTotalMs = totalMs - detectMs
      runtime.stats.lastCycleMs = totalMs
      console.log(`[CR-Notify] ${sent}/${notifications.length} notificación(es) completadas en ${totalMs}ms (detección: ${detectMs}ms, envío: ${sendTotalMs}ms)${partial ? ` (${partial} con reintento pendiente)` : ''}.`)
      return { sent, total: notifications.length, partial, skipped: null, detectMs, totalMs }
    })
  } finally {
    runtime.cronRunning = false
  }
}

function stripJidBase(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

function canManageGroup(msg, sock, isOwner) {
  if (isOwner) return true
  if (!msg.isGroup) return false
  return sock.groupMetadata(msg.chat).then((metadata) => {
    const sender = stripJidBase(msg.sender)
    return metadata?.participants?.some((participant) => {
      const ids = [participant.id, participant.lid, participant.phoneNumber].filter(Boolean).map(stripJidBase)
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
  return `Uso: ${getPrefix()}${command} [1-50]`
}

function parseNotifyLimit(args) {
  const raw = args?.[0]
  if (raw === undefined) return 1
  if (!/^\d+$/.test(String(raw).trim())) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(50, parsed) : null
}

async function runLogin({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede iniciar sesión en Crunchyroll.')
  if (msg.isGroup) return msg.reply(`⛔ Usa ${getPrefix()}crlogin únicamente por privado.`)
  const first = args[0]
  const password = args.slice(1).join(' ')
  const usageText = `💡 Uso: ${getPrefix()}crlogin correo contraseña\nO: ${getPrefix()}crlogin etp_rt`
  if (!first) return msg.reply(usageText)
  const tokenLogin = !password
  if (tokenLogin && (first.includes('@') || !/^[A-Za-z0-9._~-]{8,256}$/.test(first))) return msg.reply(usageText)
  await msg.delete?.().catch(() => {})
  try {
    if (tokenLogin) await loginWithEtpRt(first)
    else await loginWithAccount(first, password)
    updateCfg((cfg) => { cfg.cronDisabled = false })
    startCron(sock)
    await sock.sendMessage(msg.chat, {
      text: `✅ Sesión iniciada en Crunchyroll (${tokenLogin ? 'modo web etp_rt' : 'cuenta TV'}). El cron quedó activo.`,
    })
  } catch (error) {
    console.error('[CR-Notify] Login:', error.message)
    await sock.sendMessage(msg.chat, { text: `❎ No se pudo iniciar sesión en Crunchyroll: ${error.message}` })
  }
}

async function runLogout({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const cfg = updateCfg((draft) => {
    for (const key of ['accessToken', 'refreshToken', 'tokenExp', 'accountId', 'loggedIn', 'authMode', 'etpRt']) delete draft[key]
  })
  runtime.accountToken = null
  runtime.accountTokenExp = 0
  await msg.reply(`🔒 Sesión cerrada. Se conservaron ${cfg.targetJids.length} destino(s). El cron continuará en modo anónimo.`)
}

async function runSet({ msg, sock, isOwner }) {
  if (!(await canManageGroup(msg, sock, isOwner))) return msg.reply('⛔ Solo un administrador del grupo o el dueño puede usar este comando.')
  const cfg = updateCfg((draft) => {
    if (!draft.targetJids.includes(msg.chat)) draft.targetJids.push(msg.chat)
    draft.cronDisabled = false
  })
  startCron(sock)
  return msg.reply(`✅ Grupo añadido al notificador. Total de destinos: ${cfg.targetJids.length}`)
}

async function runRemove({ msg, sock, isOwner }) {
  if (!(await canManageGroup(msg, sock, isOwner))) return msg.reply('⛔ Solo un administrador del grupo o el dueño puede usar este comando.')
  let removed = false
  const cfg = updateCfg((draft) => {
    const before = draft.targetJids.length
    draft.targetJids = draft.targetJids.filter((jid) => jid !== msg.chat)
    removed = draft.targetJids.length < before
  })
  return msg.reply(!removed ? '⚠️ Este grupo no estaba configurado.' : `🗑️ Grupo eliminado. Quedan: ${cfg.targetJids.length}`)
}

async function runChannelAdd({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede añadir canales.')
  const inputs = (args || []).flatMap((value) => String(value).split(',').map((item) => item.trim()).filter(Boolean))
  if (!inputs.length) return msg.reply(`Uso: ${getPrefix()}crchanadd <ID, JID @newsletter o enlace de canal> [...]`)

  const results = []
  const toAdd = []
  const existing = new Set(loadCfg().targetJids)
  for (const input of inputs) {
    try {
      const { jid, name } = await resolveNewsletterTarget(sock, input)
      if (existing.has(jid)) {
        results.push(`ℹ️ ${name || jid}: ya estaba configurado.`)
        continue
      }
      existing.add(jid)
      toAdd.push(jid)
      results.push(`✅ ${name ? `${name} — ` : ''}${jid} añadido.`)
    } catch (error) {
      results.push(`❌ ${input}: ${error.message}`)
    }
  }
  if (toAdd.length) {
    updateCfg((cfg) => {
      cfg.targetJids.push(...toAdd)
      cfg.cronDisabled = false
    })
    startCron(sock)
  }
  return msg.reply(`📢 Canales procesados:\n${results.join('\n')}\n\nLa cuenta de WhatsApp conectada debe ser administradora del canal para publicar.`)
}

async function runChannelRemove({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede quitar canales.')
  const inputs = (args || []).flatMap((value) => String(value).split(',').map((item) => item.trim()).filter(Boolean))
  if (!inputs.length) return msg.reply(`Uso: ${getPrefix()}crchanrem <ID, JID @newsletter o enlace de canal> [...]`)

  const results = []
  const toRemove = new Set()
  const existing = new Set(loadCfg().targetJids)
  for (const input of inputs) {
    try {
      const target = parseNewsletterTarget(input)
      if (!target) throw new Error('Usa un ID numérico, un JID @newsletter o un enlace whatsapp.com/channel/... o wa.me/channel/...')
      const { jid } = target.type === 'jid' ? { jid: target.key } : await resolveNewsletterTarget(sock, input)
      if (!existing.has(jid) || toRemove.has(jid)) {
        results.push(`ℹ️ ${jid}: no estaba configurado.`)
      } else {
        toRemove.add(jid)
        results.push(`🗑️ ${jid}: eliminado.`)
      }
    } catch (error) {
      results.push(`❌ ${input}: ${error.message}`)
    }
  }
  if (toRemove.size) {
    updateCfg((cfg) => {
      cfg.targetJids = cfg.targetJids.filter((configured) => !toRemove.has(configured))
    })
  }
  return msg.reply(`📢 Canales procesados:\n${results.join('\n')}`)
}

function formatMxDate(ts) {
  return ts ? new Date(ts).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'
}

async function runStatus({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede consultar el estado del notificador.')
  const cfg = loadCfg()
  const seen = loadSeen()
  const trackedLanguages = Object.keys(loadTrackState()).length
  const pendingCount = Object.keys(loadPending()).length
  const intervalLabel = formatCronInterval(getCronIntervalMs(cfg))
  const exp = formatMxDate(cfg.tokenExp)
  const lastOk = formatMxDate(runtime.stats.lastSuccessAt)
  const lastDuration = runtime.stats.lastCycleMs ? ` (${runtime.stats.lastCycleMs}ms)` : ''
  const destinations = cfg.targetJids.length
    ? cfg.targetJids.map((jid, index) => `  ${index + 1}. ${isNewsletterJid(jid) ? 'Canal' : 'Grupo'} — ${jid}`).join('\n')
    : `  Ninguno — usa ${getPrefix()}crset o ${getPrefix()}crchanadd`
  const errorLine = runtime.stats.lastError
    ? `⚠️ Último error: *${runtime.stats.lastError}* (${formatMxDate(runtime.stats.lastErrorAt)})\n`
    : ''
  return msg.reply(
    `📊 *CR-Notify Status*\n\n` +
    `🔑 Modo: *${cfg.loggedIn ? (cfg.authMode === 'web' ? 'Cuenta real (etp_rt)' : 'Cuenta real') : 'Anónimo'}*\n` +
    `⏳ Token expira: *${exp}*\n` +
    `🔁 Refresh token: *${cfg.refreshToken ? 'Sí' : 'No'}*\n` +
    `⏱️ Cron: cada *${intervalLabel}* (*${getConfiguredNormalPages()}* pág. normal / *${getConfiguredPages()}* pág. profundo)\n` +
    `🔄 Cron activo: *${runtime.cronTimer ? 'Sí' : (cfg.cronDisabled ? 'Detenido' : 'No')}*\n` +
    `🕒 Última revisión OK: *${lastOk}*${lastDuration}\n` +
    errorLine +
    `💾 Episodios registrados: *${seen.length}/${MAX_SEEN}*\n` +
    `🈯 Episodios con pistas registradas: *${trackedLanguages}/${MAX_TRACKS}*\n` +
    `📨 Reintentos pendientes: *${pendingCount}*\n` +
    `🔐 Credenciales: *${runtime.credentialCache.source}*\n\n` +
    `🎯 *Destinos configurados (${cfg.targetJids.length}):*\n${destinations}`
  )
}

async function runCheck({ msg, sock, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  await msg.react?.('⏳').catch(() => {})
  try {
    const result = await checkAndSend(sock, true)
    if (result.skipped === 'running') {
      await msg.react?.('ℹ️').catch(() => {})
      return msg.reply('⏳ Ya hay una revisión en curso. Intenta de nuevo en unos segundos.')
    }
    if (result.skipped === 'no_targets') {
      await msg.react?.('⚠️').catch(() => {})
      return msg.reply(`⚠️ No hay destinos configurados. Usa ${getPrefix()}crset o ${getPrefix()}crchanadd.`)
    }
    await msg.react?.('✅').catch(() => {})
    const timing = Number.isFinite(result.totalMs) ? ` (${result.totalMs}ms)` : ''
    if (!result.total) return msg.reply(`✅ Revisión profunda completada${timing}: no hay episodios ni pistas nuevas.`)
    return msg.reply(`✅ Revisión profunda completada${timing}: *${result.sent}/${result.total}* notificación(es) enviadas${result.partial ? ` (${result.partial} en reintento pendiente)` : ''}.`)
  } catch (error) {
    console.error('[CR-Notify] Check manual:', error.message)
    await msg.react?.('❎').catch(() => {})
    return msg.reply(`❎ Error en la revisión: ${error.message}`)
  }
}

async function runList({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  const limit = parseNotifyLimit(args)
  if (limit === null) return msg.reply(usage('crlist'))
  await msg.react?.('⏳').catch(() => {})
  try {
    const episodes = (await fetchLatest({ limit, minPages: 1, maxPages: getConfiguredPages() })).slice(0, limit)
    if (!episodes.length) return msg.reply('📭 No se encontraron episodios recientes.')
    for (let i = 0; i < episodes.length; i++) {
      await sendEpisode(sock, msg.chat, episodes[i], msg)
      if (SEND_DELAY_MS && i < episodes.length - 1) await delay(SEND_DELAY_MS)
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
    const episodes = (await fetchLatest({ limit, minPages: 1, maxPages: getConfiguredPages() })).slice(0, limit)
    if (!episodes.length) return msg.reply('📭 No se encontraron episodios.')
    let failedCount = 0
    for (let epIndex = 0; epIndex < episodes.length; epIndex++) {
      const episode = episodes[epIndex]
      const payload = await prepareEpisodePayload(episode)
      try {
        for (let i = 0; i < jids.length; i++) {
          const jid = jids[i]
          try {
            await deliverPayload(sock, jid, payload)
            if (SEND_JID_DELAY_MS && i < jids.length - 1) await delay(SEND_JID_DELAY_MS)
          } catch (error) {
            failedCount++
            console.error(`[CR-Notify] Notify error enviando ${episode.id} a ${jid}:`, error.message)
          }
        }
      } finally {
        payload.cleanup()
      }
      if (SEND_DELAY_MS && epIndex < episodes.length - 1) await delay(SEND_DELAY_MS)
    }
    await msg.react?.(failedCount ? '⚠️' : '✅').catch(() => {})
    if (failedCount) {
      await msg.reply(`⚠️ Envío finalizado con ${failedCount} error(es) en algunos destinos. Revisa los registros.`)
    }
  } catch (error) {
    console.error('[CR-Notify] Notify:', error.message)
    await msg.react?.('❎').catch(() => {})
  }
}

async function runStop({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  updateCfg((cfg) => { cfg.cronDisabled = true })
  stopCron()
  return msg.reply(`🛑 Cron detenido. Usa ${getPrefix()}crstart para reanudarlo.`)
}

async function runStart({ msg, sock, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  updateCfg((cfg) => { cfg.cronDisabled = false })
  startCron(sock)
  return msg.reply('▶️ Cron iniciado.')
}

async function runInterval({ msg, sock, args, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño puede cambiar el intervalo global.')
  const raw = args[0]
  if (raw === undefined) return msg.reply(`Uso: ${getPrefix()}crinterval <segundos>s (1s-60s) | <minutos>m (1m-60m)`)
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
  const cfg = updateCfg((draft) => {
    if (unit === 's') {
      draft.intervalMs = intervalMs
      delete draft.minutes
    } else {
      draft.minutes = minutes
      delete draft.intervalMs
    }
  })
  const intervalLabel = formatCronInterval(intervalMs)
  if (!cfg.cronDisabled) startCron(sock)
  const warn = intervalMs < 15_000 ? '\n⚠️ Intervalos menores a 15s pueden activar límites (429) de Crunchyroll.' : ''
  return msg.reply((cfg.cronDisabled
    ? `✅ Intervalo guardado: cada ${intervalLabel}. El cron sigue detenido; usa ${getPrefix()}crstart para iniciarlo.`
    : `✅ Intervalo actualizado: cada ${intervalLabel}.`) + warn)
}

async function runDiag({ msg, isOwner }) {
  if (!isOwner) return msg.reply('⛔ Solo el dueño.')
  await msg.react?.('⏳').catch(() => {})
  const lines = []
  try {
    await refreshCredentials(true)
    const cfg = loadCfg()
    lines.push(`📡 Credenciales: *${runtime.credentialCache.source}*${runtime.credentialCache.lastError ? ` (${runtime.credentialCache.lastError})` : ''}`)
    lines.push(`🔒 HTTP/TLS: *${impit ? 'impit (Chrome)' : 'fetch nativo'}*`)
    lines.push(`🔐 Basic Auth: *${describeBasicSource(runtime.basicAuth)}*`)
    lines.push(`🧭 User-Agent: \`${runtime.userAgent.slice(0, 48)}...\``)
    try {
      const token = await getAnonToken({ forceRefresh: true })
      lines.push(`✅ Auth anónima: *OK* (\`${token.slice(0, 12)}...\`)`)
    } catch (error) {
      lines.push(`❎ Auth anónima: *FALLÓ* — ${error.message}`)
    }
    if (cfg.loggedIn) {
      try {
        const accountToken = await getToken()
        lines.push(`✅ Sesión cuenta (${cfg.authMode || 'tv'}): *OK* (\`${accountToken.slice(0, 12)}...\`)`)
      } catch (error) {
        lines.push(`❎ Sesión cuenta: *FALLÓ* — ${error.message}`)
      }
    }
    try {
      const episodes = await fetchBrowseEpisodes({ maxPages: 2, minPages: 1 })
      lines.push(`📚 API Browse: *OK* (${episodes.length} episodios aceptados)`)
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
  if (command === 'crstatus') return runStatus({ msg, isOwner })
  if (command === 'crcheck') return runCheck({ msg, sock, isOwner })
  if (command === 'crlist') return runList({ msg, sock, args, isOwner })
  if (command === 'crnotify') return runNotify({ msg, sock, args, isOwner })
  if (command === 'crstop') return runStop({ msg, isOwner })
  if (command === 'crstart') return runStart({ msg, sock, isOwner })
  if (command === 'crinterval') return runInterval({ msg, sock, args, isOwner })
  if (command === 'crdiag') return runDiag({ msg, isOwner })
}

export const __test = {
  runtime,
  normalizeLocale,
  localeFromId,
  detectAudioLocale,
  normalizeEpisode,
  mergeEpisodes,
  buildSeriesName,
  detectNotifications,
  compareNotifications,
  parseTitle,
  scoreAnilistCandidate,
  titleHasSeason,
  subtitleLine,
  formatLocale,
  caption,
  parseNotifyLimit,
  parseNewsletterTarget,
  stripJidBase,
  canManageGroup,
  getSock,
  isSockReady,
  applyCredentials,
  applyFallbackCredentials,
  applyOverrides,
  refreshCredentials,
  getAnonToken,
  getToken,
  crFetch,
  fetchBrowseEpisodes,
  fetchNew,
  checkAndSend,
  prepareEpisodePayload,
  deliverPayload,
  getConfiguredPages,
  getConfiguredNormalPages,
  formatAgeMs,
  runCommand,
  hasPendingTrackOrVersionChange,
  commitNotificationState,
  loadSeen,
  saveSeen,
  loadTrackState,
  saveTrackState,
  loadPending,
  savePending,
  loadCfg,
  updateCfg,
}

export default {
  command: ['crlogin', 'crlogout', 'crset', 'crrem', 'crchanadd', 'crchanrem', 'crstatus', 'crcheck', 'crlist', 'crnotify', 'crstop', 'crstart', 'crinterval', 'crdiag'],
  category: 'anime',
  description: 'Notificador de estrenos de Crunchyroll en grupos y canales de WhatsApp.',
  run: runCommand,
}

if (process.env.CR_DISABLE_AUTOSTART !== '1') {
  console.log('[CR-Notify] Plugin cargado. Esperando la conexión de WhatsApp...')
  if (runtime.autoStartTimer) clearInterval(runtime.autoStartTimer)
  runtime.autoStartTimer = setInterval(() => {
    if (!fs.existsSync(CURRENT_FILE_PATH)) {
      clearInterval(runtime.autoStartTimer)
      runtime.autoStartTimer = null
      return
    }
    const sock = getSock()
    if (sock) {
      clearInterval(runtime.autoStartTimer)
      runtime.autoStartTimer = null
      startCron(sock)
    }
  }, 1500)
  runtime.autoStartTimer.unref?.()
}
