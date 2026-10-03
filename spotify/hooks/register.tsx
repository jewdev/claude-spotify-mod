import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  LibraryView,
  RecapEntry,
  SpotifyDevice,
  SpotifyDj,
  SpotifyFocus,
  SpotifyItem,
  SpotifyLibrary,
  SpotifyLyrics,
  SpotifyPlayer,
  SpotifyTab,
} from '../types'
import {
  ACCOUNTS,
  API,
  PERL_LISTENER,
  SIDEBAR_TIP,
  wantsSidebarTip,
  POWERSHELL_LISTENER,
  PREMIUM_ONLY,
  PYTHON_LISTENER,
  REDIRECT_URI,
  SCOPES,
  SpotifyError,
  USAGE,
  bar,
  base64url,
  clock,
  codeFromRedirect,
  describe,
  errText,
  friendly,
  parseJson,
  parseQuery,
  toItem,
  clean,
  toPlayer,
  webUrl,
} from './lib'
import type { Pending, SearchKind, Tokens } from './lib'
import {
  DJ_INSTRUCTIONS,
  DPAPI_PROTECT,
  DPAPI_UNPROTECT,
  KEYCHAIN_CLEAR,
  KEYCHAIN_READ,
  SECRET_TOOL_CLEAR,
  SECRET_TOOL_READ,
  SECRET_TOOL_SAVE,
  isVaultSafe,
  keychainSaveInput,
  artCells,
  artScript,
  soundScript,
  artSvg,
  basename,
  chimeScript,
  hhmm,
  isSafeImageUrl,
  isTestCommand,
  lyricIndexAt,
  paletteFrom,
  parseDjPlan,
  parseLrc,
  recapCard,
  recapLine,
  recapStats,
  recapText,
  vizCells,
  vizSvg,
} from './media'
import { decodeJpegEighth, resampleHex } from './jpeg'
import {
  DEFAULT_SETTINGS,
  EMPTY_TASTE,
  ACCENTS,
  GROUP_INFO,
  SETTINGS,
  accentOf,
  changedIn,
  isToggle,
  artPixels,
  earnsDoneSound,
  clockLeft,
  findSetting,
  matchOption,
  mergeSettings,
  noticeMs,
  on as isOn,
  optionLabel,
  pollDelay,
  rememberTaste,
  tasteNote,
} from './settings'
import type { Settings, Taste } from './settings'

type Engine = EngineInterface

const PANE = 'spotify'
const TICK_MS = 250
const VIZ_MS = 100
const VIZ_COLUMNS = 40
const GREEN = '#1DB954'
const FLASH_MS = 12_000
const SKIP_MS = 30_000
const EVENT_DJ_GAP_MS = 3 * 60_000
const GROUPS = [...new Set(SETTINGS.map(s => s.group))]

const authed = atom({ plugin: 'spotify', key: 'authed' } as const, false)
const player = atom({ plugin: 'spotify', key: 'player' } as const, null)
const notice = atom({ plugin: 'spotify', key: 'notice' } as const, '')
const results = atom({ plugin: 'spotify', key: 'results' } as const, [])
const upNext = atom({ plugin: 'spotify', key: 'upNext' } as const, [])
const devices = atom({ plugin: 'spotify', key: 'devices' } as const, [])
const paneOpen = atom({ plugin: 'spotify', key: 'paneOpen' } as const, false)
const tab = atom({ plugin: 'spotify', key: 'tab' } as const, 'player')
const pos = atom({ plugin: 'spotify', key: 'pos' } as const, 0)
const lyrics = atom({ plugin: 'spotify', key: 'lyrics' } as const, null)
const lyricIndex = atom({ plugin: 'spotify', key: 'lyricIndex' } as const, -1)
const lyricOffset = atom({ plugin: 'spotify', key: 'lyricOffset' } as const, 0)
const art = atom({ plugin: 'spotify', key: 'art' } as const, null)
const IDLE_DJ: SpotifyDj = { status: 'idle', vibe: '', reason: '', picks: [], source: '', at: 0, link: '' }
const dj = atom({ plugin: 'spotify', key: 'dj' } as const, IDLE_DJ)
const recap = atom({ plugin: 'spotify', key: 'recap' } as const, [])
const premium = atom({ plugin: 'spotify', key: 'premium' } as const, null)
const busyKeys = atom({ plugin: 'spotify', key: 'busy' } as const, [])
const flash = atom({ plugin: 'spotify', key: 'flash' } as const, '')
const settings = atom({ plugin: 'spotify', key: 'settings' } as const, DEFAULT_SETTINGS)
const settingsGroup = atom({ plugin: 'spotify', key: 'settingsGroup' } as const, 'General')
const focus = atom({ plugin: 'spotify', key: 'focus' } as const, null)
const focusLeft = atom({ plugin: 'spotify', key: 'focusLeft' } as const, 0)
const IDLE_LIBRARY: SpotifyLibrary = { view: 'playlists', status: 'idle', items: [] }
const library = atom({ plugin: 'spotify', key: 'library' } as const, IDLE_LIBRARY)

const TOOL_NOW = 'mcp__spotify__now_playing'
const TOOL_CONTROL = 'mcp__spotify__control'
const TOOL_PLAY = 'mcp__spotify__play'
const TOOL_SEARCH = 'mcp__spotify__search'
const TOOL_QUEUE = 'mcp__spotify__queue'
const TOOL_DEVICES = 'mcp__spotify__devices'

/** Where a login's refresh token is kept outside the store: the macOS Keychain or Linux's Secret Service. */
type Vault = 'keychain' | 'secret-service'

/**
 * What the store keeps of a login: the refresh token plain, DPAPI-encrypted on
 * Windows, or only a note that it sits in the system keychain (macOS, Linux).
 */
type StoredTokens = {
  access?: string
  refresh?: string
  refreshEnc?: string
  scheme?: 'plain' | 'dpapi' | Vault
  expiresAt: number
  scope?: string
}

// Module state: reset on reload, which is fine (tokens live in $.store, the UI's values in $.state).
let configuredClientId = ''
let cfg: Settings = DEFAULT_SETTINGS
let polling = false
let lastPoll = 0
let lastTrack = ''
let trackStartedAt = 0
let loginRunning = false
let refreshing: Promise<Tokens> | null = null
let memAccess: { token: string; expiresAt: number } | null = null
let lastSecond = -1
let lastFocusSecond = -1
let vizEnergy = 0
let artLoading = ''
let lyricsLoading = ''
let djRunning = false
let djPicks = new Set<string>()
let lastEventDj = 0
let turnsSinceDj = 0
let turnFailures = 0
let testsFailing = false
let lastPrompt = ''
let lastShared = ''
let paneColumns = 80
let noticeSeq = 0
const artCache = new Map<string, { cells: string; palette: number[]; pixels: string }>()
const lyricsCache = new Map<string, SpotifyLyrics>()

/** Fire-and-forget: background work reports through `notice`, never as an unhandled rejection. */
function quiet(work: Promise<unknown>): void {
  work.catch(() => {})
}

/** Marks `key` busy while `work` runs, so its button can say what it is doing. */
async function withBusy($: Engine, key: string, work: () => Promise<unknown>): Promise<void> {
  await update($, busyKeys, keys => (keys.includes(key) ? keys : [...keys, key]))
  try {
    await work()
  } finally {
    await update($, busyKeys, keys => keys.filter(k => k !== key))
  }
}

/** A button's label: `working` while its key is busy. */
function busyText(busy: readonly string[], key: string, idle: string, working: string): string {
  return busy.includes(key) ? working : idle
}

/** Shows `text` in green above the prompt for a few seconds. */
async function flashGreen($: Engine, text: string) {
  await update($, flash, () => text)
  $.clock.after(FLASH_MS, () => quiet(update($, flash, f => (f === text ? '' : f))))
}

/** Sets the pane's status message; it fades after the time the settings give. */
async function say($: Engine, text: string) {
  const id = ++noticeSeq
  await update($, notice, () => text)
  const ms = noticeMs(cfg)
  if (ms !== null && text) $.clock.after(ms, () => quiet(clearNotice($, id)))
}

async function clearNotice($: Engine, id: number) {
  if (id === noticeSeq) await update($, notice, () => '')
}

async function isWindows($: Engine): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

// ---------- saved state from older versions ----------

function cleanItem(x: SpotifyItem): SpotifyItem {
  return { ...x, title: clean(x.title), subtitle: clean(x.subtitle) }
}

/**
 * Lists saved in the session's state survive a reload as they were fetched;
 * run them through `clean` so names from before it existed (emoji, unmarked
 * right-to-left text) stop throwing the pane's rows out of line.
 */
async function cleanSavedState($: Engine) {
  await update($, library, l => ({ ...l, items: l.items.map(cleanItem) }))
  await update($, results, list => list.map(cleanItem))
  await update($, upNext, list => list.map(cleanItem))
  await update($, dj, d => ({ ...d, picks: d.picks.map(cleanItem) }))
  await update($, devices, list => list.map(d => ({ ...d, name: clean(d.name) })))
  await update($, recap, list => list.map(e => ({ ...e, title: clean(e.title), artists: clean(e.artists) })))
  await update($, player, p => (p ? { ...p, title: clean(p.title), artists: clean(p.artists), album: clean(p.album), device: clean(p.device) } : p))
  await update($, lyrics, l => (l ? { ...l, lines: l.lines.map(x => ({ ...x, text: clean(x.text) })) } : l))
}

// ---------- settings ----------

async function loadSettings($: Engine) {
  const stored = await $.store.get('settings')
  let next = mergeSettings(stored)
  // 0.2 kept autopilot on its own
  if (stored === undefined && (await $.store.get('autopilot')) === true) next = { ...next, autopilot: 'on' }
  cfg = next
  await update($, settings, () => next)
}

async function setSetting($: Engine, key: string, raw: string): Promise<string> {
  const def = findSetting(key)
  if (!def) return `No setting "${key}". Run /spotify set to list them.`
  const value = matchOption(def, raw)
  if (!value) return `"${raw}" is not an option for ${def.label}: ${def.options.map(o => o.label).join(', ')}.`
  if (def.key === 'autopilot' && value === 'on' && (await read($, premium)) === false) {
    return `Autopilot queues music: ${PREMIUM_ONLY}`
  }
  const before = cfg
  cfg = { ...cfg, [def.key]: value }
  await update($, settings, () => cfg)
  await $.store.set('settings', cfg)
  if (def.key === 'protectTokens' && before.protectTokens !== value) quiet(resaveTokens($))
  if (def.key === 'statusLine') {
    const p = await read($, player)
    $.ui.status(p && value === 'on' ? `${p.isPlaying ? '♫' : '⏸'} ${p.title} — ${p.artists}` : undefined)
  }
  if (def.key === 'art' && before.art !== value) {
    const p = await read($, player)
    if (p) quiet(loadArt($, p.imageUrl))
  }
  if (def.key === 'lyrics' && value === 'on') {
    const p = await read($, player)
    if (p) quiet(loadLyrics($, p))
  }
  return `${def.label}: ${optionLabel(def, value)}.`
}

async function resetGroup($: Engine, group: string): Promise<string> {
  const defaults = Object.fromEntries(SETTINGS.filter(d => d.group === group).map(d => [d.key, d.default]))
  cfg = { ...cfg, ...defaults }
  await update($, settings, () => cfg)
  await $.store.set('settings', cfg)
  return `${group} settings reset to their defaults.`
}

async function resetSettings($: Engine): Promise<string> {
  cfg = DEFAULT_SETTINGS
  await update($, settings, () => cfg)
  await $.store.set('settings', cfg)
  return 'Settings reset to their defaults.'
}

function settingsText(s: Settings): string {
  return GROUPS.map(g =>
    [`${g}:`, ...SETTINGS.filter(d => d.group === g).map(d => `  ${d.key.padEnd(16)} ${optionLabel(d, s[d.key] ?? d.default).padEnd(14)} ${d.help}`)].join('\n'),
  ).join('\n') + '\n\nChange one with /spotify set <key> <value>, or in the Settings tab (/spotify settings).'
}

async function showGroup($: Engine, group: string) {
  await update($, settingsGroup, () => group)
}

// ---------- tokens ----------

async function clientId($: Engine): Promise<string> {
  if (configuredClientId) return configuredClientId
  const stored = await $.store.get('clientId')
  return typeof stored === 'string' ? stored : ''
}

async function hasTokens($: Engine): Promise<boolean> {
  return (await $.store.get('tokens')) != null
}

async function logout($: Engine) {
  memAccess = null
  const stored = (await $.store.get('tokens')) as StoredTokens | undefined
  if (isVault(stored?.scheme)) await vaultClear($, stored.scheme)
  await $.store.delete('tokens')
  await $.store.delete('pending')
}

async function dpapi($: Engine, script: string, input: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdin: input,
      timeoutMs: 15_000,
    })
    const out = stdout.trim()
    return exitCode === 0 && out ? out : undefined
  } catch {
    return undefined
  }
}

function isVault(scheme: StoredTokens['scheme']): scheme is Vault {
  return scheme === 'keychain' || scheme === 'secret-service'
}

/** Runs a keychain tool; its trimmed output on success, else undefined (a missing tool throws, caught here). */
async function vaultRun($: Engine, argv: string[], stdin?: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { stdin, timeoutMs: 30_000 })
    return exitCode === 0 ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function vaultRead($: Engine, vault: Vault): Promise<string | undefined> {
  const out = await vaultRun($, vault === 'keychain' ? KEYCHAIN_READ : SECRET_TOOL_READ)
  return out || undefined
}

async function vaultClear($: Engine, vault: Vault) {
  await vaultRun($, vault === 'keychain' ? KEYCHAIN_CLEAR : SECRET_TOOL_CLEAR)
}

/**
 * Saves the refresh token in the system keychain: the macOS Keychain through
 * `security`, else the Secret Service (GNOME Keyring, KWallet) through
 * `secret-tool`. The token goes on stdin, never a command line, and counts as
 * saved only once it reads back. Which one took it, or undefined for neither.
 */
async function vaultSave($: Engine, secret: string): Promise<Vault | undefined> {
  if (!isVaultSafe(secret)) return undefined
  if ((await vaultRun($, ['security', '-i'], keychainSaveInput(secret))) !== undefined && (await vaultRead($, 'keychain')) === secret) {
    return 'keychain'
  }
  if ((await vaultRun($, SECRET_TOOL_SAVE, secret)) !== undefined && (await vaultRead($, 'secret-service')) === secret) {
    return 'secret-service'
  }
  return undefined
}

/**
 * Saves a login. With encryption on, the refresh token is DPAPI-encrypted on
 * Windows or put in the system keychain elsewhere, and the access token kept
 * in memory; with it off, or where neither works, both are stored plain.
 */
async function saveTokens($: Engine, t: Tokens): Promise<StoredTokens['scheme']> {
  memAccess = { token: t.access, expiresAt: t.expiresAt }
  const before = (await $.store.get('tokens')) as StoredTokens | undefined
  let stored: StoredTokens | undefined
  if (isOn(cfg, 'protectTokens')) {
    if (await isWindows($)) {
      const enc = await dpapi($, DPAPI_PROTECT, t.refresh)
      if (enc) stored = { refreshEnc: enc, scheme: 'dpapi', expiresAt: t.expiresAt, scope: t.scope }
    } else {
      const vault = await vaultSave($, t.refresh)
      if (vault) stored = { scheme: vault, expiresAt: t.expiresAt, scope: t.scope }
    }
  }
  stored ??= { access: t.access, refresh: t.refresh, scheme: 'plain', expiresAt: t.expiresAt, scope: t.scope }
  await $.store.set('tokens', stored)
  if (isVault(before?.scheme) && before.scheme !== stored.scheme) await vaultClear($, before.scheme)
  return stored.scheme
}

async function refreshTokenOf($: Engine, stored: StoredTokens): Promise<string> {
  if (stored.scheme === 'dpapi') {
    const plain = stored.refreshEnc ? await dpapi($, DPAPI_UNPROTECT, stored.refreshEnc) : undefined
    if (!plain) throw new SpotifyError('Could not decrypt the saved Spotify login. Run /spotify login.', 401, 'not_logged_in')
    return plain
  }
  if (isVault(stored.scheme)) {
    const plain = await vaultRead($, stored.scheme)
    if (!plain) throw new SpotifyError('Could not read the saved Spotify login from the system keychain. Run /spotify login.', 401, 'not_logged_in')
    return plain
  }
  return stored.refresh ?? ''
}

/** Re-saves the login under the current encryption setting. */
async function resaveTokens($: Engine) {
  const stored = (await $.store.get('tokens')) as StoredTokens | undefined
  if (!stored) return
  const refreshToken = await refreshTokenOf($, stored)
  const access = memAccess?.token ?? stored.access ?? ''
  const scheme = await saveTokens($, { access, refresh: refreshToken, expiresAt: memAccess?.expiresAt ?? stored.expiresAt, scope: stored.scope })
  await say($, protectionNote(scheme))
}

/** What a save came to, for the person who turned encryption on or off. */
function protectionNote(scheme: StoredTokens['scheme']): string {
  if (scheme === 'dpapi') return 'Saved login encrypted with Windows DPAPI.'
  if (scheme === 'keychain') return 'Saved login moved to the macOS Keychain.'
  if (scheme === 'secret-service') return 'Saved login moved to the system keyring.'
  if (!isOn(cfg, 'protectTokens')) return 'Saved login stored without encryption.'
  return 'No system keychain answered (on Linux, install secret-tool and run a keyring); saved login stored without encryption.'
}

async function beginLogin($: Engine): Promise<string> {
  const id = await clientId($)
  if (!id) throw new SpotifyError('No client ID. Run /spotify setup <client-id> first.', 0)
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const pending: Pending = { verifier, state }
  await $.store.set('pending', pending)
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: base64url(new Uint8Array(digest)),
    state,
    scope: SCOPES,
  })
  return `${ACCOUNTS}/authorize?${params.toString()}`
}

async function finishLogin($: Engine, redirect: string): Promise<void> {
  const pending = (await $.store.get('pending')) as Pending | undefined
  if (!pending) throw new SpotifyError('No login in progress. Run /spotify login.', 0)
  const code = codeFromRedirect(redirect, pending.state)
  const tokens = await tokenRequest($, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: await clientId($),
    code_verifier: pending.verifier,
  })
  await saveTokens($, tokens)
  await $.store.delete('pending')
}

async function tokenRequest($: Engine, form: Record<string, string>, previousRefresh = ''): Promise<Tokens> {
  const res = await $.http.fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body = parseJson(res.text)
  if (!res.ok) {
    const why = body?.error_description ?? body?.error ?? res.text.slice(0, 120)
    throw new SpotifyError(`Spotify token request failed (${res.status}): ${why}`, res.status, body?.error)
  }
  const now = await $.clock.now()
  return {
    access: body.access_token,
    refresh: body.refresh_token ?? previousRefresh,
    expiresAt: now + (Number(body.expires_in ?? 3600) - 60) * 1000,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  }
}

async function refreshTokens($: Engine, stored: StoredTokens): Promise<Tokens> {
  try {
    const refreshToken = await refreshTokenOf($, stored)
    const fresh = await tokenRequest($, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: await clientId($) }, refreshToken)
    await saveTokens($, { ...fresh, scope: fresh.scope ?? stored.scope })
    return fresh
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 400) await logout($)
    throw err
  } finally {
    refreshing = null
  }
}

async function accessToken($: Engine, force: boolean): Promise<string> {
  const now = await $.clock.now()
  if (!force && memAccess && now < memAccess.expiresAt) return memAccess.token
  const stored = (await $.store.get('tokens')) as StoredTokens | undefined
  if (!stored) throw new SpotifyError('Not logged in. Run /spotify login.', 401, 'not_logged_in')
  if (!force && stored.access && now < stored.expiresAt) return stored.access
  refreshing ??= refreshTokens($, stored)
  return (await refreshing).access
}

async function grantedScope($: Engine): Promise<string> {
  return ((await $.store.get('tokens')) as StoredTokens | undefined)?.scope ?? ''
}

// ---------- browser and callback listener ----------

async function openBrowser($: Engine, url: string): Promise<boolean> {
  const tries: string[][] = (await isWindows($))
    ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
    : [['open', url], ['xdg-open', url]]
  for (const argv of tries) {
    try {
      const { exitCode } = await $.process.run(argv, { timeoutMs: 10_000 })
      if (exitCode === 0) return true
    } catch {}
  }
  return false
}

/**
 * Serves the redirect URI for up to five minutes; the callback's path, or
 * undefined. Off Windows it tries Perl, then Python: the next one only when
 * the one before is not installed.
 */
async function waitForCallback($: Engine): Promise<string | undefined> {
  const tries = (await isWindows($))
    ? [['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_LISTENER]]
    : [['perl', '-e', PERL_LISTENER], ['python3', '-c', PYTHON_LISTENER]]
  for (const argv of tries) {
    const started = await $.clock.now()
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 310_000 })
      if (exitCode === 127) continue
      const path = stdout.trim()
      return exitCode === 0 && path.includes('/callback') ? path : undefined
    } catch {
      // a quick failure is a missing program: try the next; a slow one timed out
      if ((await $.clock.now()) - started > 5000) return undefined
    }
  }
  return undefined
}

async function setPremium($: Engine, value: boolean | null) {
  if ((await read($, premium)) === value) return
  await update($, premium, () => value)
  await $.store.set('premium', value)
  if (value === false && isOn(cfg, 'autopilot')) await setSetting($, 'autopilot', 'off')
}

/** Reads the account's plan from /me (needs user-read-private; unknown without it). */
async function detectPlan($: Engine): Promise<any> {
  const me = await api($, 'GET', '/me')
  const product = me?.product
  await setPremium($, product === 'premium' ? true : typeof product === 'string' ? false : null)
  return me
}

/** "✓ Connected to Spotify as Name (Premium)." — the account the new tokens belong to. */
async function connectedMessage($: Engine): Promise<string> {
  try {
    const me = await detectPlan($)
    const who = me?.display_name || me?.id
    const tier = me?.product === 'premium' ? ' (Premium)' : me?.product ? ' (free account: see, search, like and make playlists; play in the Spotify app)' : ''
    return who ? `✓ Connected to Spotify as ${who}${tier}.` : '✓ Connected to Spotify.'
  } catch {
    return '✓ Connected to Spotify.'
  }
}

/** Tells the person the login worked: green above the prompt, a toast, and the pane's notice. */
async function announceConnected($: Engine): Promise<string> {
  const text = await connectedMessage($)
  const hint = (await read($, player)) ? '' : ' Play something, then try /spotify.'
  await flashGreen($, text + hint)
  $.ui.toast(text, { timeoutMs: 8000 })
  await say($, text)
  return text + hint
}

async function listenForLogin($: Engine) {
  if (loginRunning) return
  loginRunning = true
  try {
    const path = await waitForCallback($)
    if (!path) return
    await finishLogin($, path)
    await refresh($, true)
    await announceConnected($)
  } catch (err) {
    await say($, errText(err))
    $.ui.toast(`Spotify login failed: ${errText(err)}`)
  } finally {
    loginRunning = false
  }
}

async function login($: Engine): Promise<string> {
  let url: string
  try {
    url = await beginLogin($)
  } catch (err) {
    return (
      `${errText(err)}\n\nCreate an app at https://developer.spotify.com/dashboard with the Web API enabled ` +
      `and redirect URI ${REDIRECT_URI}, then run /spotify setup <client-id>.`
    )
  }
  const opened = await openBrowser($, url)
  quiet(listenForLogin($))
  return [
    opened ? 'Opened Spotify login in your browser.' : 'Open this URL to log in:',
    opened ? `If it did not open: ${url}` : url,
    '',
    'Login finishes by itself once you approve. If the browser shows a connection error instead,',
    'copy the URL from its address bar and run: /spotify code <that url>',
  ].join('\n')
}

// ---------- web API ----------

async function api($: Engine, method: string, path: string, body?: unknown): Promise<any> {
  const headers = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(body === undefined && method !== 'GET' ? { 'Content-Length': '0' } : {}),
  })
  const init = { method, body: body !== undefined ? JSON.stringify(body) : undefined }
  let res = await $.http.fetch(`${API}${path}`, { ...init, headers: headers(await accessToken($, false)) })
  if (res.status === 401) {
    res = await $.http.fetch(`${API}${path}`, { ...init, headers: headers(await accessToken($, true)) })
  }
  const data = parseJson(res.text)
  if (!res.ok) {
    const err = data?.error
    const message = typeof err === 'string' ? err : err?.message ?? res.text.slice(0, 160)
    if (err?.reason === 'PREMIUM_REQUIRED') await setPremium($, false)
    throw new SpotifyError(friendly(res.status, message, err?.reason), res.status, err?.reason)
  }
  return data
}

/** A player command; with no active device, moves playback to one and retries. */
async function playerCall($: Engine, method: string, path: string, body?: unknown): Promise<void> {
  if ((await read($, premium)) === false) throw new SpotifyError(PREMIUM_ONLY, 403, 'PREMIUM_REQUIRED')
  try {
    await api($, method, path, body)
  } catch (err) {
    if (!(err instanceof SpotifyError) || err.status !== 404) throw err
    const list = await getDevices($)
    const target = list.find(d => d.isActive) ?? list.find(d => d.type === 'Computer') ?? list[0]
    if (!target) throw err
    const sep = path.includes('?') ? '&' : '?'
    await api($, method, `${path}${sep}device_id=${encodeURIComponent(target.id)}`, body)
  }
}

async function getPlayer($: Engine): Promise<SpotifyPlayer | null> {
  return toPlayer(await api($, 'GET', '/me/player?additional_types=episode'), await $.clock.now())
}

async function getDevices($: Engine): Promise<SpotifyDevice[]> {
  const data = await api($, 'GET', '/me/player/devices')
  return (data?.devices ?? []).map((d: any) => ({
    id: d.id,
    name: clean(d.name),
    type: d.type,
    isActive: Boolean(d.is_active),
    volume: d.volume_percent ?? null,
  }))
}

async function getUpNext($: Engine, limit: number): Promise<SpotifyItem[]> {
  const data = await api($, 'GET', '/me/player/queue')
  return (data?.queue ?? []).slice(0, limit).map(toItem)
}

async function search($: Engine, query: string, kinds: SearchKind[], limit: number): Promise<SpotifyItem[]> {
  const params = new URLSearchParams({
    q: query,
    type: kinds.join(','),
    limit: String(Math.min(10, Math.max(1, Math.round(limit)))),
  })
  const data = await api($, 'GET', `/search?${params.toString()}`)
  const out: SpotifyItem[] = []
  for (const kind of kinds) for (const x of data?.[`${kind}s`]?.items ?? []) if (x) out.push(toItem(x))
  return out
}

async function isLiked($: Engine, uri: string): Promise<boolean | null> {
  try {
    const data = await api($, 'GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`)
    if (Array.isArray(data)) return Boolean(data[0])
  } catch {}
  try {
    const data = await api($, 'GET', `/me/tracks/contains?ids=${encodeURIComponent(uri.split(':').pop() ?? '')}`)
    if (Array.isArray(data)) return Boolean(data[0])
  } catch {}
  return null
}

async function setLiked($: Engine, uri: string, liked: boolean): Promise<void> {
  const method = liked ? 'PUT' : 'DELETE'
  try {
    await api($, method, `/me/library?uris=${encodeURIComponent(uri)}`)
    return
  } catch (err) {
    if (!(err instanceof SpotifyError) || ![400, 403, 404].includes(err.status)) throw err
  }
  await api($, method, `/me/tracks?ids=${encodeURIComponent(uri.split(':').pop() ?? '')}`)
}

async function playItem($: Engine, item: Pick<SpotifyItem, 'uri' | 'kind'>): Promise<void> {
  const body = item.kind === 'track' || item.kind === 'episode' ? { uris: [item.uri] } : { context_uri: item.uri }
  await playerCall($, 'PUT', '/me/player/play', body)
}

// ---------- refresh ----------

async function refresh($: Engine, deep: boolean): Promise<SpotifyPlayer | null> {
  if (polling && !deep) return read($, player)
  polling = true
  lastPoll = await $.clock.now()
  try {
    if (!(await hasTokens($))) {
      await update($, authed, () => false)
      await update($, player, () => null)
      $.ui.status(undefined)
      return null
    }
    await update($, authed, () => true)
    const prev = await read($, player)
    const now = await getPlayer($)
    const changed = now !== null && now.id !== lastTrack
    if (now) now.liked = !changed && prev?.id === now.id ? prev.liked : await isLiked($, now.uri)
    await update($, player, () => now)
    if (changed || deep) {
      lastTrack = now?.id ?? ''
      const queue = await getUpNext($, 5).catch(() => [] as SpotifyItem[])
      await update($, upNext, () => queue)
    }
    if (changed && now) quiet(onTrackChange($, now, prev))
    if (changed && isOn(cfg, 'trackToasts') && now?.isPlaying && prev !== null) $.ui.toast(`♫ ${now.title} — ${now.artists}`)
    $.ui.status(now && isOn(cfg, 'statusLine') ? `${now.isPlaying ? '♫' : '⏸'} ${now.title} — ${now.artists}` : undefined)
    return now
  } catch (err) {
    if (err instanceof SpotifyError && err.reason === 'not_logged_in') await update($, authed, () => false)
    await say($, errText(err))
    return read($, player)
  } finally {
    polling = false
  }
}

/** Once a second: polls when the refresh setting says it is time. */
async function pollTick($: Engine) {
  const p = await read($, player)
  const state = p ? { isPlaying: p.isPlaying, remainingMs: p.durationMs - (await positionNow($, p)) } : null
  if ((await $.clock.now()) - lastPoll >= pollDelay(cfg.polling ?? 'smart', state)) await refresh($, false)
}

async function onTrackChange($: Engine, p: SpotifyPlayer, prev: SpotifyPlayer | null) {
  const at = await $.clock.now()
  if (prev && djPicks.has(prev.uri) && isOn(cfg, 'djLearns') && at - trackStartedAt < SKIP_MS && trackStartedAt > 0) {
    await noteTaste($, 'skipped', `${prev.title} — ${prev.artists}`)
  }
  trackStartedAt = at
  await update($, lyricIndex, () => -1)
  const offsets = ((await $.store.get('lyricOffsets')) ?? {}) as Record<string, number>
  await update($, lyricOffset, () => offsets[p.id] ?? 0)
  await update($, recap, list => {
    if (list[list.length - 1]?.uri === p.uri) return list
    const entry: RecapEntry = { at, uri: p.uri, title: p.title, artists: p.artists, tools: 0, failures: 0, files: [], moments: [] }
    return [...list, entry].slice(-200)
  })
  await Promise.all([loadLyrics($, p), loadArt($, p.imageUrl)])
}

/** The playback position now, from the last poll and the time since. */
async function positionNow($: Engine, p: SpotifyPlayer): Promise<number> {
  if (!p.isPlaying) return p.progressMs
  return Math.min(p.durationMs, p.progressMs + ((await $.clock.now()) - p.fetchedAt))
}

/** Four times a second: the pane's clock, the lyric line, and the focus timer. */
async function tick($: Engine) {
  await focusTick($)
  const p = await read($, player)
  if (!p) return
  const at = await positionNow($, p)
  if (await read($, paneOpen)) {
    const second = Math.floor(at / 1000)
    if (second !== lastSecond) {
      lastSecond = second
      await update($, pos, () => at)
    }
  }
  const l = await read($, lyrics)
  if (l?.trackId === p.id && l.status === 'synced') {
    const idx = lyricIndexAt(l.lines, at + 300 + (await read($, lyricOffset)))
    if (idx !== (await read($, lyricIndex))) await update($, lyricIndex, () => idx)
  }
}

/** Ten times a second while the player tab shows: repaints the terminal spectrum in place. */
async function vizFrame($: Engine) {
  if (!isOn(cfg, 'visualizer') || !(await read($, paneOpen)) || (await read($, tab)) !== 'player') return
  const p = await read($, player)
  if (!p) return
  const target = p.isPlaying ? 1 : 0
  if (vizEnergy === 0 && target === 0) return
  vizEnergy = target > vizEnergy ? Math.min(1, vizEnergy + 0.2) : Math.max(0, vizEnergy - 0.1)
  const a = await read($, art)
  const columns = Math.min(VIZ_COLUMNS, paneColumns)
  const cells = vizCells(columns, Number(cfg.vizHeight ?? 5), await positionNow($, p), p.id, a?.palette ?? [], vizEnergy)
  try {
    await $.ui.blit({ requestId: PANE, key: 'viz', cells })
  } catch {}
}

// ---------- lyrics ----------

async function lrclib($: Engine, path: string): Promise<any> {
  const res = await $.http.fetch(`https://lrclib.net/api/${path}`, {
    headers: { 'User-Agent': 'claude-code-spotify-mod/0.3 (https://github.com/jewdev/claude-spotify-mod)' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`)
  return parseJson(res.text)
}

async function loadLyrics($: Engine, p: SpotifyPlayer) {
  if (!isOn(cfg, 'lyrics')) return
  if (p.kind !== 'track') {
    await update($, lyrics, (): SpotifyLyrics => ({ trackId: p.id, status: 'missing', lines: [] }))
    return
  }
  const cached = lyricsCache.get(p.id)
  if (cached) {
    await update($, lyrics, () => cached)
    return
  }
  if (lyricsLoading === p.id) return
  lyricsLoading = p.id
  await update($, lyrics, (): SpotifyLyrics => ({ trackId: p.id, status: 'loading', lines: [] }))
  let found: SpotifyLyrics
  try {
    const artist = p.artists.split(',')[0]!.trim()
    const exact = new URLSearchParams({
      track_name: p.title,
      artist_name: artist,
      album_name: p.album,
      duration: String(Math.round(p.durationMs / 1000)),
    })
    let hit = await lrclib($, `get?${exact.toString()}`)
    if (!hit) {
      const list = await lrclib($, `search?${new URLSearchParams({ track_name: p.title, artist_name: artist }).toString()}`)
      const items: any[] = Array.isArray(list) ? list : []
      hit = items.find(x => x?.syncedLyrics) ?? items.find(x => x?.plainLyrics) ?? null
    }
    if (!hit) found = { trackId: p.id, status: 'missing', lines: [] }
    else if (hit.instrumental) found = { trackId: p.id, status: 'instrumental', lines: [] }
    else if (hit.syncedLyrics) found = { trackId: p.id, status: 'synced', lines: parseLrc(hit.syncedLyrics) }
    else if (hit.plainLyrics)
      found = { trackId: p.id, status: 'plain', lines: String(hit.plainLyrics).split(/\r?\n/).map(text => ({ t: 0, text })) }
    else found = { trackId: p.id, status: 'missing', lines: [] }
    lyricsCache.set(p.id, found)
  } catch {
    found = { trackId: p.id, status: 'error', lines: [] }
  } finally {
    lyricsLoading = ''
  }
  if ((await read($, player))?.id === p.id) await update($, lyrics, () => found)
}

async function currentLyric($: Engine): Promise<string | undefined> {
  const l = await read($, lyrics)
  const idx = await read($, lyricIndex)
  return l?.status === 'synced' && idx >= 0 ? l.lines[idx]?.text || undefined : undefined
}

/** Moves the current track's lyrics earlier or later; remembered per track. */
async function nudgeLyrics($: Engine, deltaMs: number | null): Promise<string> {
  const p = await read($, player)
  if (!p) return 'Nothing is playing.'
  const next = deltaMs === null ? 0 : Math.max(-10_000, Math.min(10_000, (await read($, lyricOffset)) + deltaMs))
  await update($, lyricOffset, () => next)
  const offsets = ((await $.store.get('lyricOffsets')) ?? {}) as Record<string, number>
  const kept = Object.entries({ ...offsets, [p.id]: next }).filter(([, v]) => v !== 0).slice(-200)
  await $.store.set('lyricOffsets', Object.fromEntries(kept))
  return next === 0 ? 'Lyrics timing reset.' : `Lyrics ${next > 0 ? 'earlier' : 'later'} by ${Math.abs(next) / 1000}s.`
}

// ---------- album art ----------

async function loadArt($: Engine, url: string) {
  const size = artPixels(cfg)
  if (!url || size === 0) {
    await update($, art, () => null)
    return
  }
  const key = `${url}@${size}`
  const cached = artCache.get(key)
  if (cached) {
    await update($, art, () => ({ url, size, columns: size, rows: size / 2, ...cached }))
    return
  }
  if (artLoading === key || !isSafeImageUrl(url)) return
  artLoading = key
  try {
    const hex = (await isWindows($)) ? await artViaPowerShell($, url, size) : await artViaCurl($, url, size)
    if (hex?.length !== size * size * 6) return
    const drawn = { cells: artCells(hex, size, size), palette: paletteFrom(hex), pixels: hex }
    artCache.set(key, drawn)
    if ((await read($, player))?.imageUrl === url) {
      await update($, art, () => ({ url, size, columns: size, rows: size / 2, ...drawn }))
    }
  } catch {
  } finally {
    artLoading = ''
  }
}

/** Windows: PowerShell downloads and scales the cover. */
async function artViaPowerShell($: Engine, url: string, size: number): Promise<string | undefined> {
  const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', artScript(url, size)]
  const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 20_000 })
  return exitCode === 0 ? stdout.trim() : undefined
}

/** macOS and Linux: curl downloads the cover to a temp file and the mod decodes the JPEG itself. */
async function artViaCurl($: Engine, url: string, size: number): Promise<string | undefined> {
  const dir = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  const file = `${dir}/claude-spotify-art.jpg`
  const { exitCode } = await $.process.run(['curl', '-sfL', '--max-time', '15', '-o', file, url], { timeoutMs: 20_000 })
  if (exitCode !== 0) return undefined
  const got = await $.fs.read(file, { as: 'bytes' })
  if (typeof got === 'string') return undefined
  const img = decodeJpegEighth(Uint8Array.from(atob(got.base64), c => c.charCodeAt(0)))
  return img ? resampleHex(img, size) : undefined
}

// ---------- actions (each resolves a line describing the outcome) ----------

async function act($: Engine, done: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    await say($, done)
    // give Spotify a moment to apply it; a timer so it also works from background work
    $.clock.after(350, () => quiet(refresh($, true)))
    return done
  } catch (err) {
    const text = errText(err)
    await say($, text)
    return text
  }
}

async function resume($: Engine) {
  return act($, 'Playing.', () => playerCall($, 'PUT', '/me/player/play'))
}

async function pause($: Engine) {
  return act($, 'Paused.', () => playerCall($, 'PUT', '/me/player/pause'))
}

async function skip($: Engine) {
  return act($, 'Skipped.', () => playerCall($, 'POST', '/me/player/next'))
}

async function back($: Engine) {
  return act($, 'Previous track.', () => playerCall($, 'POST', '/me/player/previous'))
}

async function toggle($: Engine) {
  const p = await read($, player)
  return p?.isPlaying ? pause($) : resume($)
}

async function setVolume($: Engine, percent: number) {
  const v = Math.round(Math.min(100, Math.max(0, percent)))
  return act($, `Volume ${v}%.`, () => playerCall($, 'PUT', `/me/player/volume?volume_percent=${v}`))
}

async function volumeBy($: Engine, delta: number) {
  const p = await read($, player)
  return setVolume($, (p?.volume ?? 50) + delta)
}

async function seekTo($: Engine, ms: number) {
  const at = Math.max(0, Math.round(ms))
  return act($, `Seeked to ${clock(at)}.`, () => playerCall($, 'PUT', `/me/player/seek?position_ms=${at}`))
}

async function setShuffle($: Engine, enabled: boolean) {
  return act($, `Shuffle ${enabled ? 'on' : 'off'}.`, () => playerCall($, 'PUT', `/me/player/shuffle?state=${enabled}`))
}

async function toggleShuffle($: Engine) {
  const p = await read($, player)
  return setShuffle($, !p?.shuffle)
}

async function setRepeat($: Engine, mode: 'off' | 'track' | 'context') {
  return act($, `Repeat ${mode}.`, () => playerCall($, 'PUT', `/me/player/repeat?state=${mode}`))
}

async function cycleRepeat($: Engine) {
  const p = await read($, player)
  return setRepeat($, p?.repeat === 'off' ? 'context' : p?.repeat === 'context' ? 'track' : 'off')
}

async function like($: Engine, liked: boolean | undefined) {
  const p = await refresh($, true)
  if (!p) return 'Nothing is playing.'
  const want = liked ?? !p.liked
  if (want && djPicks.has(p.uri) && isOn(cfg, 'djLearns')) await noteTaste($, 'liked', `${p.title} — ${p.artists}`)
  return act($, want ? `Saved "${p.title}" to Liked Songs.` : `Removed "${p.title}" from Liked Songs.`, async () => {
    await setLiked($, p.uri, want)
    lastTrack = ''
  })
}

async function openInSpotify($: Engine, item: SpotifyItem): Promise<string> {
  const opened = await openBrowser($, webUrl(item.uri))
  const text = opened
    ? `Opened ${item.kind} "${item.title}" in Spotify. A free account can't start playback from here.`
    : `Open ${item.kind} "${item.title}" in Spotify: ${webUrl(item.uri)}`
  await say($, text)
  return text
}

async function playPick($: Engine, item: SpotifyItem) {
  if ((await read($, premium)) === false) return openInSpotify($, item)
  return act($, `Playing ${item.kind} "${item.title}" (${item.subtitle}).`, () => playItem($, item))
}

async function enqueue($: Engine, uri: string, label: string) {
  return act($, `Queued ${label}.`, () => playerCall($, 'POST', `/me/player/queue?uri=${encodeURIComponent(uri)}`))
}

async function playQuery($: Engine, raw: string, kind: SearchKind | undefined) {
  const parsed = kind ? { query: raw, kind } : parseQuery(raw)
  try {
    const [hit] = await search($, parsed.query, [parsed.kind], 1)
    return hit ? playPick($, hit) : `No ${parsed.kind} found for "${parsed.query}".`
  } catch (err) {
    return errText(err)
  }
}

async function queueQuery($: Engine, raw: string) {
  if (raw.startsWith('spotify:track:')) return enqueue($, raw, raw)
  try {
    const [hit] = await search($, raw, ['track'], 1)
    return hit ? enqueue($, hit.uri, `"${hit.title}" (${hit.subtitle})`) : `No track found for "${raw}".`
  } catch (err) {
    return errText(err)
  }
}

async function runSearch($: Engine, raw: string): Promise<SpotifyItem[]> {
  await say($, `Searching for "${raw.trim()}"…`)
  try {
    const { query, kind, explicit } = parseQuery(raw)
    const kinds: SearchKind[] = explicit ? [kind] : ['track', 'album', 'playlist']
    const found = await search($, query, kinds, explicit ? 8 : 4)
    await update($, results, () => found)
    await say($, found.length ? `${found.length} results for "${query}".` : `No results for "${query}".`)
    return found
  } catch (err) {
    await say($, errText(err))
    return []
  }
}

async function loadDevices($: Engine): Promise<SpotifyDevice[]> {
  try {
    const list = await getDevices($)
    await update($, devices, () => list)
    return list
  } catch (err) {
    await say($, errText(err))
    return []
  }
}

async function useDevice($: Engine, nameOrId: string) {
  const list = await loadDevices($)
  const needle = nameOrId.toLowerCase()
  const d = list.find(x => x.id === nameOrId) ?? list.find(x => x.name.toLowerCase().includes(needle))
  if (!d) {
    const names = list.map(x => x.name).join(', ') || 'none (open Spotify somewhere first)'
    return `No device matching "${nameOrId}". Devices: ${names}.`
  }
  return act($, `Playing on ${d.name}.`, () => api($, 'PUT', '/me/player', { device_ids: [d.id], play: true }))
}

async function openPane($: Engine, which: SpotifyTab | undefined) {
  if (which) await update($, tab, () => which)
  await $.ui.open({ id: PANE, title: 'Spotify' })
  await update($, paneOpen, () => true)
  quiet(loadDevices($))
  quiet(refresh($, true))
  if (which === 'library') quiet(loadLibrary($, undefined))
}

async function showTab($: Engine, which: SpotifyTab) {
  await update($, tab, () => which)
  if (which === 'library' && (await read($, library)).status === 'idle') quiet(loadLibrary($, undefined))
}

async function pressLogin($: Engine) {
  const text = await login($)
  await say($, text.split('\n')[0] ?? '')
}

async function pressLogout($: Engine) {
  await logout($)
  await refresh($, true)
}

// ---------- cues: when Claude finishes, or needs you (sounds only: the music is left alone) ----------

/** Plays one of the mod's sounds (or Windows' own) at the volume the settings give; `off` plays nothing. */
async function playSound($: Engine, sound: string, kind: 'done' | 'waiting') {
  if (!sound || sound === 'off') return
  const volume = Number(cfg.soundVolume ?? 75) / 100
  const windows = await isWindows($)
  try {
    if (windows && sound === 'system') {
      await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', chimeScript(kind)], { timeoutMs: 5000 })
    } else if (windows) {
      const path = `${$.plugin.root}\\assets\\${sound}.wav`
      await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', soundScript(path, volume)], { timeoutMs: 8000 })
    } else {
      await $.audio.play({ asset: `assets/${sound === 'system' ? 'chime' : sound}.wav` }, { gain: volume })
    }
  } catch {}
}

async function waitingCue($: Engine) {
  await playSound($, cfg.waitingSound ?? 'off', 'waiting')
}

/** The settings page's "test" button: plays the sound a setting names right now. */
async function testSound($: Engine, key: string) {
  const sound = cfg[key] ?? 'off'
  if (sound === 'off') {
    await say($, 'That sound is off. Pick one to hear it.')
    return
  }
  await playSound($, sound, key === 'waitingSound' ? 'waiting' : 'done')
}


// ---------- focus timer ----------

async function startFocus($: Engine, minutesArg: number | undefined): Promise<string> {
  const minutes = minutesArg ?? Number(cfg.focusLength ?? 25)
  const endsAt = (await $.clock.now()) + minutes * 60_000
  const block: SpotifyFocus = { phase: 'focus', endsAt, minutes }
  await update($, focus, () => block)
  lastFocusSecond = -1
  return `Focus: ${minutes} minutes${Number(cfg.breakLength) > 0 ? `, then a ${cfg.breakLength}-minute break` : ''}. /spotify focus stop ends it.`
}

async function stopFocus($: Engine): Promise<string> {
  const f = await read($, focus)
  await update($, focus, () => null)
  return f ? 'Focus timer stopped.' : 'No focus timer is running.'
}

async function focusTick($: Engine) {
  const f = await read($, focus)
  if (!f) return
  const left = f.endsAt - (await $.clock.now())
  const second = Math.max(0, Math.ceil(left / 1000))
  if (second !== lastFocusSecond) {
    lastFocusSecond = second
    await update($, focusLeft, () => second)
  }
  if (left > 0) return
  if (f.phase === 'focus') {
    const breakMin = Number(cfg.breakLength ?? 0)
    quiet(playSound($, cfg.focusSound ?? 'bell', 'done'))
    if (breakMin > 0) {
      const breakBlock: SpotifyFocus = { phase: 'break', endsAt: (await $.clock.now()) + breakMin * 60_000, minutes: breakMin }
      await update($, focus, () => breakBlock)
      await flashGreen($, `✓ ${f.minutes} minutes of focus done. Take ${breakMin}: stand up, stretch, drink water.`)
    } else {
      await update($, focus, () => null)
      await flashGreen($, `✓ ${f.minutes} minutes of focus done.`)
    }
    return
  }
  await update($, focus, () => null)
  quiet(playSound($, cfg.focusSound ?? 'bell', 'waiting'))
  await flashGreen($, '✓ Break over. /spotify focus starts another block.')
}

// ---------- library ----------

async function loadLibrary($: Engine, view: LibraryView | undefined) {
  const which = view ?? (await read($, library)).view
  await update($, library, (): SpotifyLibrary => ({ view: which, status: 'loading', items: [] }))
  try {
    let items: SpotifyItem[] = []
    if (which === 'playlists') {
      const data = await api($, 'GET', '/me/playlists?limit=30')
      items = (data?.items ?? []).filter(Boolean).map(toItem)
    } else if (which === 'liked') {
      const data = await api($, 'GET', '/me/tracks?limit=30')
      items = (data?.items ?? []).map((x: any) => x?.track).filter(Boolean).map(toItem)
    } else {
      const data = await api($, 'GET', '/me/player/recently-played?limit=30')
      const seen = new Set<string>()
      for (const x of data?.items ?? []) {
        const t = x?.track
        if (t && !seen.has(t.uri)) {
          seen.add(t.uri)
          items.push(toItem(t))
        }
      }
    }
    await update($, library, (): SpotifyLibrary => ({ view: which, status: 'done', items }))
  } catch (err) {
    await update($, library, (): SpotifyLibrary => ({ view: which, status: 'error', items: [] }))
    await say($, errText(err))
  }
}

// ---------- DJ ----------

async function noteTaste($: Engine, kind: 'liked' | 'skipped', label: string) {
  const taste = ((await $.store.get('taste')) as Taste | undefined) ?? EMPTY_TASTE
  await $.store.set('taste', rememberTaste(taste, kind, label))
}

/** What the session has been doing lately, for the autopilot's cheap model call. */
async function activitySummary($: Engine): Promise<string> {
  const entries = (await read($, recap)).slice(-4)
  const p = await read($, player)
  const lines = [
    lastPrompt ? `The user's latest request: "${lastPrompt.slice(0, 300)}"` : '',
    ...entries.map(e => `While "${e.title}" by ${e.artists} played: ${recapLine(e)}`),
    testsFailing ? 'Tests are currently failing.' : '',
    turnFailures ? `${turnFailures} tool calls failed in the last turn.` : '',
    p ? `Now playing: "${p.title}" by ${p.artists}.` : 'Nothing is playing.',
  ]
  return lines.filter(Boolean).join('\n')
}

async function askDj($: Engine, source: SpotifyDj['source'], hint: string, count: number): Promise<string> {
  const taste = isOn(cfg, 'djLearns') ? tasteNote(((await $.store.get('taste')) as Taste | undefined) ?? EMPTY_TASTE) : ''
  const extra = `${hint ? ` The user adds: "${hint}".` : ''}${taste ? ` ${taste}` : ''}`
  if (source !== 'autopilot') {
    const forked = await $.model.fork({
      prompt: `${DJ_INSTRUCTIONS}\nPick ${count} tracks.${extra}\nBase the pick on what we have been working on in this conversation. Answer with the JSON only.`,
    })
    if (forked.isAnswered) return forked.text
  }
  const r = await $.model.complete({
    model: 'haiku',
    system: DJ_INSTRUCTIONS,
    prompt: `${await activitySummary($)}\n\nPick ${count} tracks.${extra}`,
    maxTokens: 900,
    timeoutMs: 45_000,
  })
  if (!r.isAnswered) throw new Error(`The DJ could not answer (${r.reason}).`)
  return r.text
}

async function runDj($: Engine, source: SpotifyDj['source'], hint: string) {
  if (djRunning) return
  djRunning = true
  turnsSinceDj = 0
  const count = source === 'autopilot' ? 3 : Number(cfg.djCount ?? 6)
  await update($, dj, (d): SpotifyDj => ({ ...d, status: 'thinking', source }))
  try {
    const plan = parseDjPlan(await askDj($, source, hint, count))
    if (!plan) throw new Error('The DJ answered without a playlist.')
    const hits = await Promise.all(
      plan.tracks.slice(0, count).map(t => search($, `${t.title} ${t.artist}`, ['track'], 1).then(r => r[0], () => undefined)),
    )
    const picks = hits.filter((x): x is SpotifyItem => x !== undefined)
    if (picks.length === 0) throw new Error('None of the DJ picks were found on Spotify.')
    picks.forEach(x => djPicks.add(x.uri))
    const at = await $.clock.now()
    if ((await read($, premium)) === false) {
      const link = await djPlaylist($, plan.vibe, plan.reason, picks)
      await update($, dj, () => ({ status: 'done', vibe: plan.vibe, reason: plan.reason, picks, source, at, link }))
      const text = link ? `DJ · ${plan.vibe}: saved ${picks.length} tracks as a playlist and opened it.` : `DJ · ${plan.vibe}: ${picks.length} picks. ${RELOGIN}`
      $.ui.toast(text, { timeoutMs: 8000 })
      await say($, text)
      return
    }
    const p = await read($, player)
    if (!p?.isPlaying && source !== 'autopilot') {
      await playerCall($, 'PUT', '/me/player/play', { uris: picks.map(x => x.uri) })
    } else {
      for (const x of picks) await playerCall($, 'POST', `/me/player/queue?uri=${encodeURIComponent(x.uri)}`)
    }
    await update($, dj, () => ({ status: 'done', vibe: plan.vibe, reason: plan.reason, picks, source, at, link: '' }))
    const verb = !p?.isPlaying && source !== 'autopilot' ? 'playing' : 'queued'
    $.ui.toast(`DJ · ${plan.vibe}: ${picks.length} tracks ${verb}`)
    await say($, `DJ ${verb} ${picks.length} tracks: ${plan.vibe}.`)
    await refresh($, true)
  } catch (err) {
    await update($, dj, (d): SpotifyDj => ({ ...d, status: 'error', reason: errText(err) }))
  } finally {
    djRunning = false
  }
}

/** Autopilot, steered by what just happened: failing tests calm it, green tests lift it. */
async function djOnEvent($: Engine, hint: string) {
  if (!isOn(cfg, 'autopilot') || !isOn(cfg, 'djEvents') || djRunning) return
  if ((await read($, premium)) === false) return
  const now = await $.clock.now()
  if (now - lastEventDj < EVENT_DJ_GAP_MS) return
  lastEventDj = now
  await runDj($, 'autopilot', hint)
}

// ---------- recap ----------

async function noteActivity($: Engine, file: string | undefined, failed: boolean, moment: string | undefined) {
  await update($, recap, list => {
    const last = list[list.length - 1]
    if (!last) return list
    const files = file && !last.files.includes(file) ? [...last.files, file] : last.files
    const moments = moment ? [...last.moments, moment].slice(-4) : last.moments
    return [...list.slice(0, -1), { ...last, tools: last.tools + 1, failures: last.failures + (failed ? 1 : 0), files, moments }]
  })
}

const RELOGIN = 'Spotify needs playlist permission first: run /spotify login once more, approve, then save again.'

function hasPlaylistScope(scope: string): boolean {
  return scope.includes('playlist-modify')
}

/** Creates a private playlist of `uris`; resolves its link. */
async function createPlaylist($: Engine, title: string, description: string, uris: string[]): Promise<string> {
  let list: any
  try {
    list = await api($, 'POST', '/me/playlists', { name: title, description, public: false })
  } catch (err) {
    if (!(err instanceof SpotifyError) || (err.status !== 404 && err.status !== 405)) throw err
    const me = await api($, 'GET', '/me')
    list = await api($, 'POST', `/users/${encodeURIComponent(me.id)}/playlists`, { name: title, description, public: false })
  }
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100)
    try {
      await api($, 'POST', `/playlists/${list.id}/items`, { uris: chunk })
    } catch (err) {
      if (!(err instanceof SpotifyError) || (err.status !== 404 && err.status !== 405)) throw err
      await api($, 'POST', `/playlists/${list.id}/tracks`, { uris: chunk })
    }
  }
  return list.external_urls?.spotify ?? webUrl(`spotify:playlist:${list.id}`)
}

/** A free account's DJ set: saved as a playlist and opened; '' when that is not allowed. */
async function djPlaylist($: Engine, vibe: string, reason: string, picks: SpotifyItem[]): Promise<string> {
  if (!hasPlaylistScope(await grantedScope($))) return ''
  try {
    const link = await createPlaylist($, `Claude DJ · ${vibe}`, reason.slice(0, 280), picks.map(x => x.uri))
    await openBrowser($, link)
    return link
  } catch {
    return ''
  }
}

async function savePlaylist($: Engine, name: string): Promise<string> {
  if (!hasPlaylistScope(await grantedScope($))) return RELOGIN
  const entries = await read($, recap)
  const uris = [...new Set(entries.map(e => e.uri).filter(u => u.startsWith('spotify:track:')))]
  if (uris.length === 0) return 'Nothing to save yet: no tracks have played this session.'
  const first = entries[0]
  const title = name || `Claude Code session · ${first ? new Date(first.at).toDateString() : ''}`.trim()
  const description = `Soundtrack of a Claude Code session: ${entries.length} tracks.`
  try {
    const link = await createPlaylist($, title, description, uris)
    return `✓ Saved "${title}" with ${uris.length} tracks. ${link}`
  } catch (err) {
    if (err instanceof SpotifyError && (err.status === 403 || err.status === 401)) {
      return `${RELOGIN} (Spotify said: ${err.message})`
    }
    return errText(err)
  }
}

/** A recap row as something to play. */
function recapItem(e: RecapEntry): SpotifyItem {
  return { uri: e.uri, kind: e.uri.startsWith('spotify:episode:') ? 'episode' : 'track', title: e.title, subtitle: e.artists }
}

/** Plays the whole session soundtrack from its first track (Premium). */
async function playRecap($: Engine): Promise<string> {
  const uris = [...new Set((await read($, recap)).map(e => e.uri).filter(u => u.startsWith('spotify:track:')))]
  if (uris.length === 0) return 'Nothing to play yet: no tracks have played this session.'
  return act($, `Playing the session soundtrack: ${uris.length} tracks.`, () => playerCall($, 'PUT', '/me/player/play', { uris }))
}

async function pressSave($: Engine) {
  await say($, 'Saving the session as a playlist…')
  const text = await savePlaylist($, '')
  await say($, text)
  $.ui.toast(text, { timeoutMs: 8000 })
}

async function copyCard($: Engine, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  const text = recapCard(await read($, recap), await $.clock.now())
  const { isCopied } = await $.ui.copy({ text, surface })
  await say($, isCopied ? '✓ Session summary copied to the clipboard.' : 'Could not reach the clipboard here; /spotify recap shows the summary.')
}

async function recapWithStats($: Engine): Promise<string> {
  const entries = await read($, recap)
  if (entries.length === 0) return recapText(entries)
  return `${recapCard(entries, await $.clock.now())}\n\n${recapText(entries)}`
}

// ---------- Claude awareness ----------

async function shareNowPlaying($: Engine) {
  if (!isOn(cfg, 'shareNowPlaying')) return
  const p = await read($, player)
  if (!p?.isPlaying || p.id === lastShared) return
  lastShared = p.id
  await $.session.append({
    message: {
      type: 'user',
      content: [{ type: 'text', text: `(From the user's Spotify mod: they are listening to "${p.title}" by ${p.artists}.)` }],
    },
  })
}

// ---------- tools for Claude ----------

async function registerTools($: Engine) {
  await $.tool.register({
    name: 'now_playing',
    description:
      "Returns what is playing on the user's Spotify right now: track, artist, album, position, device, volume, " +
      'shuffle, repeat, and the lyric line being sung when synced lyrics exist.',
  })
  await $.tool.register({
    name: 'control',
    description:
      "Controls the user's Spotify playback. Actions: play (resume), pause, next, previous, volume (value 0-100), " +
      'seek (value in seconds), shuffle_on, shuffle_off, repeat_off, repeat_track, repeat_context, like (save current track), unlike.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'previous', 'volume', 'seek', 'shuffle_on', 'shuffle_off', 'repeat_off', 'repeat_track', 'repeat_context', 'like', 'unlike'],
        },
        value: { type: 'number', description: 'Volume percent for volume; seconds for seek.' },
      },
      required: ['action'],
    },
  })
  await $.tool.register({
    name: 'play',
    description:
      "Searches Spotify and immediately plays the best match on the user's device. Use type playlist for a mood or genre " +
      "(e.g. 'lofi beats', 'deep focus'), album or artist to play those.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to play, e.g. "Bohemian Rhapsody Queen" or "deep focus".' },
        type: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'], default: 'track' },
      },
      required: ['query'],
    },
  })
  await $.tool.register({
    name: 'search',
    description: 'Searches Spotify and returns matching items with their Spotify URIs, without playing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'], default: 'track' },
        limit: { type: 'number', minimum: 1, maximum: 10, default: 5 },
      },
      required: ['query'],
    },
  })
  await $.tool.register({
    name: 'queue',
    description:
      "Adds a track to the user's Spotify queue (a spotify:track: URI, or a search query whose best track match is queued). " +
      'With no query, lists what is up next.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A search query or a spotify:track:... URI. Omit to list the queue.' } },
    },
  })
  await $.tool.register({
    name: 'devices',
    description: "Lists the user's Spotify devices, or moves playback to one when transfer_to names a device.",
    inputSchema: {
      type: 'object',
      properties: { transfer_to: { type: 'string', description: 'Device name (partial match) or id.' } },
    },
  })
}

async function nowPlayingText($: Engine): Promise<string> {
  const text = describe(await refresh($, true))
  const line = await currentLyric($)
  return line ? `${text} Current lyric: "${line}".` : text
}

async function runControl($: Engine, action: string, value: number | undefined): Promise<string> {
  switch (action) {
    case 'play': return resume($)
    case 'pause': return pause($)
    case 'next': return skip($)
    case 'previous': return back($)
    case 'volume': return setVolume($, Number(value ?? 50))
    case 'seek': return seekTo($, Number(value ?? 0) * 1000)
    case 'shuffle_on': return setShuffle($, true)
    case 'shuffle_off': return setShuffle($, false)
    case 'repeat_off': return setRepeat($, 'off')
    case 'repeat_track': return setRepeat($, 'track')
    case 'repeat_context': return setRepeat($, 'context')
    case 'like': return like($, true)
    case 'unlike': return like($, false)
    default: return `Unknown action "${action}".`
  }
}

async function listQueue($: Engine): Promise<string> {
  try {
    const list = await getUpNext($, 10)
    return list.map((x, i) => `${i + 1}. ${x.title} — ${x.subtitle}`).join('\n') || 'The queue is empty.'
  } catch (err) {
    return errText(err)
  }
}

async function searchText($: Engine, query: string, kind: SearchKind, limit: number): Promise<string> {
  try {
    const found = await search($, query, [kind], limit)
    await update($, results, () => found)
    return found.map(x => `${x.title} — ${x.subtitle} [${x.uri}]`).join('\n') || 'No results.'
  } catch (err) {
    return errText(err)
  }
}

async function listDevices($: Engine): Promise<string> {
  const list = await loadDevices($)
  return list.length
    ? list.map(d => `${d.isActive ? '▶' : ' '} ${d.name} (${d.type}), volume ${d.volume ?? '?'}%`).join('\n')
    : 'No devices are online. Open Spotify on your computer or phone first.'
}

async function lyricsText($: Engine): Promise<string> {
  if (!isOn(cfg, 'lyrics')) return 'Lyrics are off. Turn them on with /spotify set lyrics on.'
  const p = await refresh($, true)
  if (!p) return 'Nothing is playing.'
  const l = await read($, lyrics)
  if (!l || l.trackId !== p.id || l.status === 'loading') return `Looking up lyrics for "${p.title}"…`
  if (l.status === 'instrumental') return `"${p.title}" is instrumental.`
  if (l.status !== 'synced' && l.status !== 'plain') return `No lyrics found for "${p.title}".`
  const line = await currentLyric($)
  return line ? `♪ ${line}` : `Lyrics for "${p.title}" are in the pane.`
}

async function runCommand($: Engine, args: string): Promise<string> {
  const [head = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (head.toLowerCase()) {
    case '':
    case 'pane':
    case 'open':
      await openPane($, cfg.defaultTab && cfg.defaultTab !== 'last' ? (cfg.defaultTab as SpotifyTab) : undefined)
      return (await hasTokens($)) ? 'Spotify pane opened.' : 'Spotify pane opened. Run /spotify login to connect.'
    case 'help':
      return USAGE
    case 'setup':
      if (!arg) return `Usage: /spotify setup <client-id>\nRedirect URI to register: ${REDIRECT_URI}`
      await $.store.set('clientId', arg)
      return 'Client ID saved. Now run /spotify login.'
    case 'login':
      return login($)
    case 'code':
      if (!arg) return 'Usage: /spotify code <redirect url>'
      try {
        await finishLogin($, arg)
        await refresh($, true)
        return await connectedMessage($)
      } catch (err) {
        return errText(err)
      }
    case 'logout':
      await pressLogout($)
      return 'Logged out of Spotify.'
    case 'now':
    case 'status':
      return nowPlayingText($)
    case 'play':
      return arg ? playQuery($, arg, undefined) : resume($)
    case 'pause':
      return pause($)
    case 'toggle':
    case 'pp':
      return toggle($)
    case 'next':
    case 'skip':
      return skip($)
    case 'prev':
    case 'previous':
    case 'back':
      return back($)
    case 'vol':
    case 'volume':
      if (/^[+-]\d+$/.test(arg)) return volumeBy($, Number(arg))
      if (!arg || Number.isNaN(Number(arg))) return 'Usage: /spotify vol <0-100|+N|-N>'
      return setVolume($, Number(arg))
    case 'seek': {
      const m = /^(?:(\d+):)?(\d+)$/.exec(arg)
      if (!m) return 'Usage: /spotify seek <seconds|m:ss>'
      return seekTo($, (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000)
    }
    case 'shuffle':
      return toggleShuffle($)
    case 'repeat':
      return cycleRepeat($)
    case 'like':
    case 'save':
      return like($, undefined)
    case 'queue':
    case 'q':
      return arg ? queueQuery($, arg) : listQueue($)
    case 'search':
    case 'find': {
      if (!arg) return 'Usage: /spotify search <query>'
      const found = await runSearch($, arg)
      await openPane($, 'player')
      return found.map((x, i) => `${i + 1}. ${x.title} — ${x.subtitle}`).join('\n') || 'No results.'
    }
    case 'devices':
      return `${await listDevices($)}\n\nSwitch with /spotify device <name>.`
    case 'device':
      return arg ? useDevice($, arg) : 'Usage: /spotify device <name>'
    case 'band':
      return setSetting($, 'band', isOn(cfg, 'band') ? 'off' : 'on')
    case 'lyrics':
    case 'lyric': {
      if (/^(earlier|later|reset|[+-]\d+(\.\d+)?)$/i.test(arg)) {
        const delta = /^reset$/i.test(arg) ? null : /^earlier$/i.test(arg) ? 500 : /^later$/i.test(arg) ? -500 : Number(arg) * 1000
        return nudgeLyrics($, delta)
      }
      await openPane($, 'lyrics')
      return lyricsText($)
    }
    case 'dj':
      if (djRunning) return 'The DJ is already picking.'
      quiet(runDj($, arg ? 'hint' : 'session', arg))
      await openPane($, 'dj')
      return 'The DJ is reading the session and picking tracks…'
    case 'autopilot':
      return setSetting($, 'autopilot', arg === 'on' || arg === 'off' ? arg : isOn(cfg, 'autopilot') ? 'off' : 'on')
    case 'recap': {
      if (/^save\b/i.test(arg)) return savePlaylist($, arg.replace(/^save\s*/i, ''))
      const playArg = /^play(?:\s+(\d+))?$/i.exec(arg)
      if (playArg) {
        if (!playArg[1]) return playRecap($)
        const entry = (await read($, recap))[Number(playArg[1]) - 1]
        return entry ? playPick($, recapItem(entry)) : `No track #${playArg[1]} in this session's recap.`
      }
      await openPane($, 'recap')
      return recapWithStats($)
    }
    case 'library':
    case 'lib':
      await openPane($, 'library')
      return 'Your library is in the pane.'
    case 'focus': {
      if (/^(stop|off|end)$/i.test(arg)) return stopFocus($)
      const f = await read($, focus)
      if (/^status$/i.test(arg) || (!arg && f)) {
        return f ? `${f.phase === 'focus' ? 'Focus' : 'Break'}: ${clockLeft(f.endsAt - (await $.clock.now()))} left.` : 'No focus timer is running.'
      }
      const minutes = arg ? Number(arg) : undefined
      if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240)) return 'Usage: /spotify focus [minutes|stop|status]'
      return startFocus($, minutes)
    }
    case 'settings':
    case 'config':
      await openPane($, 'settings')
      return settingsText(cfg)
    case 'set': {
      if (!arg) return settingsText(cfg)
      if (/^reset$/i.test(arg)) return resetSettings($)
      const [key = '', ...value] = arg.split(/\s+/)
      return setSetting($, key, value.join(' '))
    }
    default:
      return `Unknown subcommand "${head}".\n\n${USAGE}`
  }
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  configuredClientId = String(options.clientId ?? '').trim()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await loadSettings($)
    await cleanSavedState($)
    await $.command.register({
      name: 'spotify',
      description: 'Spotify: player, lyrics, Claude DJ, focus timer, recap, library and settings',
      argumentHint: '[play <q>|pause|next|lyrics|dj [hint]|focus [min]|recap|library|settings|help]',
      immediate: true,
    })
    await registerTools($)
    const plan = await $.store.get('premium')
    if (typeof plan === 'boolean') await update($, premium, () => plan)
    if (await hasTokens($)) quiet(detectPlan($))
    quiet(refresh($, true))
    $.clock.every(1000, () => quiet(pollTick($)))
    $.clock.every(TICK_MS, () => quiet(tick($)))
    $.clock.every(VIZ_MS, () => quiet(vizFrame($)))
    return started
  })

  on('command.run', { command: 'spotify' }, async ($, e) => {
    const text = await runCommand($, e.args)
    // once ever: the pane opened above the prompt on a terminal wide enough for the sidebar
    if (!wantsSidebarTip(e.args, e.presentation) || (await $.store.get('sidebarTipShown'))) return { text }
    await $.store.set('sidebarTipShown', true)
    return { text: `${text}
${SIDEBAR_TIP}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, paneOpen, () => false)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await shareNowPlaying($).catch(() => {})
    return next(e)
  })

  // The session's mood, for the recap, the DJ and the cues
  on('turn.start', async ($, e, next) => {
    if (e.text) lastPrompt = e.text
    turnFailures = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    if (earnsDoneSound(cfg, e.durationMs, e.isAborted)) quiet(playSound($, cfg.doneSound ?? 'chime', 'done'))
    turnsSinceDj += 1
    const due = turnsSinceDj >= Number(cfg.djTurns ?? 4) || turnFailures >= 3
    const p = await read($, player)
    const free = (await read($, premium)) === false
    if (due && !free && p?.isPlaying && !djRunning && isOn(cfg, 'autopilot')) quiet(runDj($, 'autopilot', ''))
    return done
  })

  // A permission prompt: Claude is waiting on the person
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') quiet(waitingCue($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (name === 'AskUserQuestion') quiet(waitingCue($))
    const ran = await next(e)
    if (name.startsWith('mcp__spotify__')) return ran
    const failed = 'isError' in ran && ran.isError === true
    if (failed) turnFailures += 1
    const input = e as unknown as { file_path?: string; command?: string }
    const file = (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && input.file_path ? basename(input.file_path) : undefined
    let moment: string | undefined
    if (name === 'Bash' && input.command && isTestCommand(input.command)) {
      if (failed) {
        if (!testsFailing) {
          moment = 'tests failed ✗'
          quiet(djOnEvent($, 'Tests just started failing: steady, calm, focused music to debug to.'))
        }
        testsFailing = true
      } else if (testsFailing) {
        testsFailing = false
        moment = 'tests green ✓'
        $.ui.toast('Tests green ✓')
        quiet(djOnEvent($, 'Tests just went green: something upbeat and celebratory.'))
      }
    }
    await noteActivity($, file, failed, moment)
    return ran
  })

  // Tools Claude can call
  on('tool.call', { tool: TOOL_NOW as never }, async $ => ({ result: await nowPlayingText($) }))

  on('tool.call', { tool: TOOL_CONTROL as never }, async ($, e) => {
    const { action, value } = e as unknown as { action: string; value?: number }
    return { result: await runControl($, action, value) }
  })

  on('tool.call', { tool: TOOL_PLAY as never }, async ($, e) => {
    const { query, type } = e as unknown as { query: string; type?: SearchKind }
    return { result: await playQuery($, query, type ?? 'track') }
  })

  on('tool.call', { tool: TOOL_SEARCH as never }, async ($, e) => {
    const { query, type, limit } = e as unknown as { query: string; type?: SearchKind; limit?: number }
    return { result: await searchText($, query, type ?? 'track', limit ?? 5) }
  })

  on('tool.call', { tool: TOOL_QUEUE as never }, async ($, e) => {
    const { query } = e as unknown as { query?: string }
    return { result: query ? await queueQuery($, query) : await listQueue($) }
  })

  on('tool.call', { tool: TOOL_DEVICES as never }, async ($, e) => {
    const { transfer_to } = e as unknown as { transfer_to?: string }
    return { result: transfer_to ? await useDevice($, transfer_to) : await listDevices($) }
  })

  // A /spotify answer that reports success draws in green
  on('ui.render', { component: 'CommandOutput', props: { command: 'spotify' } }, async ($, e, next) => {
    if (!e.props.text.startsWith('✓')) return next(e)
    const { Text } = $.ui.resolve(e)
    const GREEN = accentOf(await read($, settings))
    return (
      <Text color={GREEN} wrap="wrap">
        {e.props.text}
      </Text>
    )
  })

  // Above the prompt: a green success line, the focus countdown, and the now-playing band
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, settings)
    const GREEN = accentOf(s)
    const shout = await read($, flash)
    const f = await read($, focus)
    const left = f ? await read($, focusLeft) : 0
    const p = isOn(s, 'band') ? await read($, player) : null
    if (!p && !shout && !f) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = p && isOn(s, 'bandLyrics') ? await currentLyric($) : undefined
    const canControl = (await read($, premium)) !== false
    const busy = await read($, busyKeys)

    return (
      <Box flexDirection="column">
        {shout !== '' && (
          <Text color={GREEN} bold wrap="wrap">
            {shout}
          </Text>
        )}
        {f && (
          <Box flexDirection="row" gap={1}>
            <Text color={f.phase === 'focus' ? GREEN : 'yellow'} bold>
              {f.phase === 'focus' ? '◎ Focus' : '☕ Break'} {clockLeft(left * 1000)}
            </Text>
            <Button key="focus-stop" label="stop" plain dimColor onPress={() => quiet(stopFocus($))} />
          </Box>
        )}
        {p && (
          <Box flexDirection="row" gap={1}>
            <Text color={GREEN}>{p.isPlaying ? '♫' : '⏸'}</Text>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text bold>{p.title}</Text>
                <Text dimColor> — {p.artists}</Text>
              </Text>
            </Box>
            {isOn(s, 'bandTime') && e.props.bodyColumns > 70 && <Text dimColor>{clock(p.progressMs)}/{clock(p.durationMs)}</Text>}
            {canControl && isOn(s, 'bandControls') && <Button key="band-prev" label={busyText(busy, 'band-prev', '⏮', '…')} plain onPress={() => quiet(withBusy($, 'band-prev', () => back($)))} />}
            {canControl && isOn(s, 'bandControls') && <Button key="band-toggle" label={busyText(busy, 'band-toggle', p.isPlaying ? '⏸' : '▶', '…')} plain onPress={() => quiet(withBusy($, 'band-toggle', () => toggle($)))} />}
            {canControl && isOn(s, 'bandControls') && <Button key="band-next" label={busyText(busy, 'band-next', '⏭', '…')} plain onPress={() => quiet(withBusy($, 'band-next', () => skip($)))} />}
            {isOn(s, 'bandControls') && <Button key="band-like" label={busyText(busy, 'band-like', p.liked ? '♥' : '♡', '…')} plain onPress={() => quiet(withBusy($, 'band-like', () => like($, undefined)))} />}
            {isOn(s, 'bandControls') && <Button key="band-open" label="☰" plain dimColor onPress={() => quiet(openPane($, undefined))} />}
          </Box>
        )}
        {line !== undefined && p?.isPlaying && (
          <Text italic color={GREEN} dimColor wrap="truncate-end">
            {'  ♪ '}
            {line}
          </Text>
        )}
      </Box>
    )
  })

  // The pane: Player, Lyrics, DJ, Recap, Library and Settings
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const width = Math.max(20, e.props.bodyColumns)
    paneColumns = width
    const height = e.viewport?.rows ?? 30
    const isAuthed = await read($, authed)
    const message = await read($, notice)
    const busy = await read($, busyKeys)
    const s = await read($, settings)
    const GREEN = accentOf(s)
    const good = message.startsWith('✓')
    const messageLine = message !== '' && (
      <Text color={good ? GREEN : undefined} dimColor={!good} wrap="wrap">
        {message}
      </Text>
    )

    if (!isAuthed) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color={GREEN}>Spotify</Text>
          <Text>Not connected.</Text>
          <Box flexDirection="column">
            <Text dimColor wrap="wrap">1. Create an app at developer.spotify.com/dashboard (Web API, redirect URI {REDIRECT_URI})</Text>
            <Text dimColor>2. /spotify setup &lt;client-id&gt;</Text>
            <Text dimColor>3. Press Log in, or run /spotify login</Text>
          </Box>
          <Box>
            <Button key="login" label={busyText(busy, 'login', 'Log in', 'Opening browser…')} variant="primary" hotkey="l" onPress={() => quiet(withBusy($, 'login', () => pressLogin($)))} />
          </Box>
          {messageLine}
        </Box>
      )
    }

    const current = await read($, tab)
    const p = await read($, player)
    const free = (await read($, premium)) === false
    const tabButton = (key: SpotifyTab, label: string, hotkey: string) => (
      <Button
        key={`tab-${key}`}
        label={label}
        hotkey={hotkey}
        variant={current === key ? 'primary' : undefined}
        dimColor={current !== key}
        onPress={() => quiet(showTab($, key))}
      />
    )
    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {tabButton('player', 'Player', '1')}
        {tabButton('lyrics', 'Lyrics', '2')}
        {tabButton('dj', 'DJ', '3')}
        {tabButton('recap', 'Recap', '4')}
        {tabButton('library', 'Library', '5')}
        {tabButton('settings', 'Settings', '6')}
      </Box>
    )
    const header = p ? (
      <Text wrap="truncate-end">
        <Text color={GREEN}>{p.isPlaying ? '♫ ' : '⏸ '}</Text>
        <Text bold>{p.title}</Text>
        <Text dimColor> — {p.artists}</Text>
      </Text>
    ) : (
      <Text dimColor>Nothing playing.</Text>
    )
    const playLabel = (key: string, isCurrent: boolean) => busyText(busy, key, free ? '↗' : isCurrent && p?.isPlaying ? '♫' : '▶', '…')

    // ----- lyrics tab -----
    if (current === 'lyrics') {
      const l = await read($, lyrics)
      const idx = await read($, lyricIndex)
      const offset = await read($, lyricOffset)
      const room = Math.max(5, Math.min(24, height - 10))
      let body
      if (!isOn(s, 'lyrics')) body = <Text dimColor>Lyrics are off. Turn them on in Settings (6).</Text>
      else if (!p) body = <Text dimColor>Start a track to see its lyrics.</Text>
      else if (!l || l.trackId !== p.id || l.status === 'loading') body = <Text dimColor>Looking up lyrics…</Text>
      else if (l.status === 'instrumental') body = <Text dimColor>♪ Instrumental ♪</Text>
      else if (l.status === 'missing') body = <Text dimColor>No lyrics found on LRCLIB for this track.</Text>
      else if (l.status === 'error') body = <Text dimColor>Could not reach LRCLIB.</Text>
      else if (l.status === 'plain') {
        body = (
          <Box flexDirection="column">
            <Text dimColor italic>Unsynced lyrics</Text>
            {l.lines.slice(0, room).map(x => <Text wrap="wrap">{x.text || ' '}</Text>)}
          </Box>
        )
      } else {
        const start = Math.max(0, Math.min(Math.max(0, idx) - Math.floor(room / 3), l.lines.length - room))
        body = (
          <Box flexDirection="column">
            {l.lines.slice(start, start + room).map((x, k) => {
              const i = start + k
              return (
                <Button
                  key={`ly-${i}`}
                  plain
                  label={`${i === idx ? '▶ ' : '  '}${x.text || '♪'}`}
                  dimColor={i !== idx}
                  onPress={() => quiet(seekTo($, x.t - offset))}
                />
              )
            })}
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>timing{offset !== 0 ? ` ${offset > 0 ? '+' : ''}${offset / 1000}s` : ''}:</Text>
              <Button key="ly-earlier" label="earlier" hotkey="z" plain dimColor onPress={() => quiet(nudgeLyrics($, 500))} />
              <Button key="ly-later" label="later" hotkey="x" plain dimColor onPress={() => quiet(nudgeLyrics($, -500))} />
              {offset !== 0 && <Button key="ly-reset" label="reset" hotkey="c" plain dimColor onPress={() => quiet(nudgeLyrics($, null))} />}
            </Box>
            <Text dimColor>press a line to jump there · lyrics from lrclib.net</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {header}
          {body}
        </Box>
      )
    }

    // ----- DJ tab -----
    if (current === 'dj') {
      const d = await read($, dj)
      const auto = isOn(s, 'autopilot')
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {header}
          <Box flexDirection="column">
            <Text bold>Claude DJ</Text>
            {d.status === 'idle' && <Text dimColor wrap="wrap">Picks music for what you are working on in this session, then plays or queues it.</Text>}
            {d.status === 'thinking' && <Text color={GREEN}>Reading the session and digging through crates…</Text>}
            {d.status === 'error' && <Text color="yellow" wrap="wrap">{d.reason}</Text>}
            {d.status === 'done' && (
              <Box flexDirection="column">
                <Text>
                  <Text color={GREEN} bold>{d.vibe}</Text>
                  <Text dimColor> · {d.source === 'autopilot' ? 'autopilot' : 'on request'} at {hhmm(d.at)}</Text>
                </Text>
                <Text italic wrap="wrap">{d.reason}</Text>
              </Box>
            )}
          </Box>
          {d.picks.length > 0 && (
            <Box flexDirection="column">
              {d.picks.map((x, i) => (
                <Box flexDirection="row" gap={1}>
                  <Button key={`dj-play-${i}`} label={playLabel(`dj-play-${i}`, p?.uri === x.uri)} plain onPress={() => quiet(withBusy($, `dj-play-${i}`, () => playPick($, x)))} />
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      {x.title}
                      <Text dimColor> — {x.subtitle}</Text>
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          <Box flexDirection="row" columnGap={1}>
            <Button key="dj-spin" label={d.status === 'thinking' ? 'picking…' : free ? 'Make a playlist' : 'Spin a set'} hotkey="j" variant="primary" onPress={() => quiet(runDj($, 'session', ''))} />
            {!free && <Button key="dj-auto" label={`Autopilot: ${auto ? 'on' : 'off'}`} hotkey="a" onPress={() => quiet(setSetting($, 'autopilot', auto ? 'off' : 'on'))} />}
            {free && d.link !== '' && <Button key="dj-open" label="Open playlist" hotkey="o" onPress={() => quiet(openBrowser($, d.link))} />}
          </Box>
          <Text dimColor wrap="wrap">
            {free
              ? 'Free account: the DJ saves its picks as a playlist and opens it in Spotify. /spotify dj <hint> steers it.'
              : `Autopilot re-picks every few turns${isOn(s, 'djEvents') ? ', and when tests fail or pass' : ''}. ${isOn(s, 'djLearns') ? 'It learns from DJ picks you skip or like. ' : ''}/spotify dj <hint> steers it.`}
          </Text>
          {messageLine}
        </Box>
      )
    }

    // ----- recap tab -----
    if (current === 'recap') {
      const entries = await read($, recap)
      const stats = recapStats(entries, await $.clock.now())
      const room = Math.max(3, Math.floor((height - 12) / 2))
      const shown = entries.slice(-room)
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="column">
            <Text bold>Session soundtrack · {entries.length} track{entries.length === 1 ? '' : 's'}{entries.length ? ` · ${stats.minutes} min` : ''}</Text>
            {stats.topArtist !== '' && (
              <Text dimColor wrap="truncate-end">
                top artist {stats.topArtist} ({stats.topArtistCount}×){stats.busiest ? ` · most productive: "${stats.busiest.title}"` : ''} · {stats.files} files
              </Text>
            )}
          </Box>
          {entries.length === 0 && <Text dimColor>Tracks you play during this session show here, with what Claude was doing meanwhile.</Text>}
          {messageLine}
          <Box flexDirection="column">
            {entries.length > shown.length && <Text dimColor>… {entries.length - shown.length} earlier</Text>}
            {shown.map((x, k) => {
              const i = entries.length - shown.length + k
              const playing = p?.uri === x.uri
              return (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key={`recap-play-${i}`}
                      label={playLabel(`recap-play-${i}`, playing)}
                      plain
                      dimColor={playing}
                      onPress={() => quiet(withBusy($, `recap-play-${i}`, () => playPick($, recapItem(x))))}
                    />
                    <Box flexShrink={1}>
                      <Text wrap="truncate-end">
                        <Text dimColor>{hhmm(x.at)} </Text>
                        <Text bold={playing} color={playing ? GREEN : undefined}>{x.title}</Text>
                        <Text dimColor> — {x.artists}</Text>
                      </Text>
                    </Box>
                  </Box>
                  <Text dimColor wrap="truncate-end">{'    '}{recapLine(x)}</Text>
                </Box>
              )
            })}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {!free && entries.length > 0 && (
              <Button key="recap-all" label={busyText(busy, 'recap-all', '▶ Play all', 'starting…')} hotkey="p" onPress={() => quiet(withBusy($, 'recap-all', () => playRecap($)))} />
            )}
            <Button key="recap-save" label={busyText(busy, 'recap-save', 'Save as playlist', 'Saving…')} hotkey="v" variant="primary" onPress={() => quiet(withBusy($, 'recap-save', () => pressSave($)))} />
            {entries.length > 0 && (
              <Button key="recap-copy" label="Copy summary" hotkey="y" onPress={press => quiet(copyCard($, press.surface))} />
            )}
          </Box>
        </Box>
      )
    }

    // ----- library tab -----
    if (current === 'library') {
      const lib = await read($, library)
      const room = Math.max(5, height - 10)
      const viewButton = (view: LibraryView, label: string, hotkey: string) => (
        <Button
          key={`lib-${view}`}
          label={busyText(busy, `lib-${view}`, label, `${label}…`)}
          hotkey={hotkey}
          variant={lib.view === view ? 'primary' : undefined}
          dimColor={lib.view !== view}
          onPress={() => quiet(withBusy($, `lib-${view}`, () => loadLibrary($, view)))}
        />
      )
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="row" columnGap={1}>
            {viewButton('playlists', 'Playlists', 'q')}
            {viewButton('liked', 'Liked Songs', 'w')}
            {viewButton('recent', 'Recently played', 'e')}
          </Box>
          {lib.status === 'loading' && <Text dimColor>Loading…</Text>}
          {lib.status === 'idle' && <Text dimColor>Pick a list above.</Text>}
          {lib.status === 'done' && lib.items.length === 0 && <Text dimColor>Nothing here yet.</Text>}
          {lib.status === 'error' && <Text color="yellow">Spotify did not return this list.</Text>}
          {lib.items.length > 0 && (
            <Box flexDirection="column">
              {lib.items.slice(0, room).map((x, i) => (
                <Box flexDirection="row" gap={1}>
                  <Button key={`lib-play-${i}`} label={playLabel(`lib-play-${i}`, p?.uri === x.uri)} plain onPress={() => quiet(withBusy($, `lib-play-${i}`, () => playPick($, x)))} />
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      {x.title}
                      <Text dimColor> — {x.subtitle}</Text>
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          {messageLine}
        </Box>
      )
    }

    // ----- settings tab -----
    if (current === 'settings') {
      const group = await read($, settingsGroup)
      const defs = SETTINGS.filter(d => d.group === group)
      const labelWidth = Math.min(26, Math.max(...defs.map(d => d.label.length)) + 2)
      const pick = (key: string, value: string) => quiet(setSetting($, key, value).then(t => say($, `✓ ${t}`)))

      // a mock band from the current settings, so its switches show what they change
      const sample = p ?? { title: 'Song title', artists: 'Artist', isPlaying: true, progressMs: 83_000, durationMs: 214_000, liked: false }
      const sampleLine = (await currentLyric($)) ?? 'the line being sung'
      const bandPreview = (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {isOn(s, 'band') ? (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={GREEN}>{sample.isPlaying ? '♫ ' : '⏸ '}</Text>
                <Text bold>{sample.title}</Text>
                <Text dimColor> — {sample.artists}</Text>
                {isOn(s, 'bandTime') && <Text dimColor> {clock(sample.progressMs)}/{clock(sample.durationMs)}</Text>}
                {isOn(s, 'bandControls') && <Text> ⏮ ⏸ ⏭ {sample.liked ? '♥' : '♡'} ☰</Text>}
              </Text>
              {isOn(s, 'bandLyrics') && (
                <Text italic color={GREEN} dimColor wrap="truncate-end">
                  {'  ♪ '}
                  {sampleLine}
                </Text>
              )}
            </Box>
          ) : (
            <Text dimColor>The band is hidden.</Text>
          )}
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {GROUPS.map(g => {
              const changed = changedIn(s, g)
              return (
                <Button
                  key={`group-${g}`}
                  label={changed ? `${g} •` : g}
                  variant={g === group ? 'primary' : undefined}
                  dimColor={g !== group}
                  onPress={() => quiet(showGroup($, g))}
                />
              )
            })}
          </Box>
          <Box flexDirection="column">
            <Text bold color={GREEN}>
              {group}
            </Text>
            <Text dimColor wrap="wrap">
              {GROUP_INFO[group] ?? ''}
            </Text>
          </Box>
          {group === 'Band' && bandPreview}
          <Box flexDirection="column" gap={1}>
            {defs.map(d => {
              const value = s[d.key] ?? d.default
              const changed = value !== d.default
              let control
              if (isToggle(d)) {
                const enabled = value === 'on'
                control = (
                  <Button
                    key={`set-${d.key}`}
                    label={enabled ? '● On ' : '○ Off'}
                    variant={enabled ? 'primary' : undefined}
                    dimColor={!enabled}
                    onPress={() => pick(d.key, enabled ? 'off' : 'on')}
                  />
                )
              } else {
                control = (
                  <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
                    {d.options.map(o => {
                      const chosen = o.value === value
                      const swatch = d.key === 'accent' ? ACCENTS[o.value] : undefined
                      return (
                        <Box flexDirection="row">
                          {swatch !== undefined && <Text color={swatch}>■</Text>}
                          {chosen ? (
                            <Button key={`set-${d.key}-${o.value}`} label={o.label} variant="primary" onPress={() => pick(d.key, o.value)} />
                          ) : (
                            <Button key={`set-${d.key}-${o.value}`} label={o.label} plain dimColor onPress={() => pick(d.key, o.value)} />
                          )}
                        </Box>
                      )
                    })}
                    {d.isSound && (
                      <Button
                        key={`test-${d.key}`}
                        label={busyText(busy, `test-${d.key}`, '▶ test', 'playing…')}
                        plain
                        onPress={() => quiet(withBusy($, `test-${d.key}`, () => testSound($, d.key)))}
                      />
                    )}
                  </Box>
                )
              }
              return (
                <Box flexDirection="column">
                  <Box flexDirection="row" columnGap={1}>
                    <Box width={labelWidth} flexShrink={0}>
                      <Text bold={changed} wrap="truncate-end">
                        {d.label}
                        {changed ? ' •' : ''}
                      </Text>
                    </Box>
                    {control}
                  </Box>
                  <Text dimColor wrap="wrap">
                    {d.help}
                    {d.key === 'accent' ? ' ' : ''}
                    {d.key === 'accent' && (
                      <Text color={GREEN} bold>
                        Preview: ♫ {sample.title}
                      </Text>
                    )}
                  </Text>
                </Box>
              )
            })}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {changedIn(s, group) > 0 && (
              <Button key="settings-reset-group" label={`Reset ${group}`} plain dimColor onPress={() => quiet(resetGroup($, group).then(t => say($, `✓ ${t}`)))} />
            )}
            <Button key="settings-reset" label="Reset all" plain dimColor onPress={() => quiet(resetSettings($).then(t => say($, `✓ ${t}`)))} />
          </Box>
          <Text dimColor>• changed from the default · also /spotify set &lt;key&gt; &lt;value&gt;</Text>
          {messageLine}
        </Box>
      )
    }

    // ----- player tab -----
    const found = await read($, results)
    const queue = await read($, upNext)
    const devs = await read($, devices)
    const cover = await read($, art)
    const at = await read($, pos)
    const shownPos = p ? (p.isPlaying ? Math.max(at, p.progressMs) : p.progressMs) : 0
    const line = await currentLyric($)
    const showArt = cover !== null && p !== null && cover.url === p.imageUrl && width >= 50 && s.art !== 'off'
    const vizColumns = Math.min(VIZ_COLUMNS, width)
    const vizRows = Number(s.vizHeight ?? 5)
    const showViz = p !== null && isOn(s, 'visualizer')

    const info = p ? (
      <Box flexDirection="column" flexShrink={1}>
        <Text bold color={GREEN} wrap="truncate-end">{p.isPlaying ? '♫ ' : '⏸ '}{p.title}</Text>
        <Text wrap="truncate-end">{p.artists}</Text>
        <Text dimColor wrap="truncate-end">{p.album}</Text>
        <Text>
          <Text color={GREEN}>{bar(shownPos, p.durationMs, Math.min(30, width - (showArt ? cover.columns + 16 : 14)))}</Text>
          <Text dimColor> {clock(shownPos)} / {clock(p.durationMs)}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {p.device || 'unknown device'} · vol {p.volume ?? '?'}% · shuffle {p.shuffle ? 'on' : 'off'} · repeat {p.repeat}
        </Text>
        {line !== undefined && <Text italic dimColor wrap="truncate-end">♪ {line}</Text>}
      </Box>
    ) : (
      <Text dimColor>Nothing playing. Start Spotify on a device, search below, or press DJ.</Text>
    )

    let artElement = null
    if (showArt && 'Raster' in ui) artElement = <ui.Raster key="art" columns={cover.columns} rows={cover.rows} cells={cover.cells} />
    else if (showArt && 'Svg' in ui) artElement = <ui.Svg source={artSvg(cover.pixels, cover.size, Math.max(3, Math.round(120 / cover.size)))} alt={`Cover of ${p.album}`} />

    let vizElement = null
    if (showViz && 'Raster' in ui) {
      vizElement = <ui.Raster key="viz" columns={vizColumns} rows={vizRows} cells={vizCells(vizColumns, vizRows, shownPos, p.id, cover?.palette ?? [], p.isPlaying ? 1 : 0)} />
    } else if (showViz && 'Svg' in ui) {
      vizElement = <ui.Svg source={vizSvg(24, p.id, cover?.palette ?? [], p.isPlaying)} alt="Visualizer" isInteractive />
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {artElement ? (
          <Box flexDirection="row" gap={2}>
            {artElement}
            {info}
          </Box>
        ) : (
          info
        )}
        {vizElement}

        {free ? (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Button key="like" label={busyText(busy, 'like', p?.liked ? '♥ liked' : '♡ like', '♥ saving…')} hotkey="l" onPress={() => quiet(withBusy($, 'like', () => like($, undefined)))} />
            </Box>
            <Text dimColor wrap="wrap">Free account: play, pause and skip in the Spotify app. ↗ opens a track there.</Text>
          </Box>
        ) : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="prev" label={busyText(busy, 'prev', '⏮ prev', '⏮ …')} hotkey="b" onPress={() => quiet(withBusy($, 'prev', () => back($)))} />
            <Button key="toggle" label={busyText(busy, 'toggle', p?.isPlaying ? '⏸ pause' : '▶ play', p?.isPlaying ? '⏸ pausing…' : '▶ starting…')} hotkey="p" variant="primary" onPress={() => quiet(withBusy($, 'toggle', () => toggle($)))} />
            <Button key="next" label={busyText(busy, 'next', '⏭ next', '⏭ skipping…')} hotkey="n" onPress={() => quiet(withBusy($, 'next', () => skip($)))} />
            <Button key="voldown" label={busyText(busy, 'voldown', 'vol −', 'vol …')} hotkey="d" onPress={() => quiet(withBusy($, 'voldown', () => volumeBy($, -10)))} />
            <Button key="volup" label={busyText(busy, 'volup', 'vol +', 'vol …')} hotkey="u" onPress={() => quiet(withBusy($, 'volup', () => volumeBy($, 10)))} />
            <Button key="shuffle" label={busyText(busy, 'shuffle', p?.shuffle ? 'shuffle on' : 'shuffle off', 'shuffle …')} hotkey="s" onPress={() => quiet(withBusy($, 'shuffle', () => toggleShuffle($)))} />
            <Button key="repeat" label={busyText(busy, 'repeat', `repeat ${p?.repeat ?? 'off'}`, 'repeat …')} hotkey="r" onPress={() => quiet(withBusy($, 'repeat', () => cycleRepeat($)))} />
            <Button key="like" label={busyText(busy, 'like', p?.liked ? '♥ liked' : '♡ like', '♥ saving…')} hotkey="l" onPress={() => quiet(withBusy($, 'like', () => like($, undefined)))} />
          </Box>
        )}

        {messageLine}

        {'Input' in ui && isOn(s, 'showSearch') && (
          <ui.Input
            key="search"
            label="Search"
            placeholder="song · artist: … · album: … · playlist: …"
            submitLabel={busyText(busy, 'search', 'Search', 'Searching…')}
            onSubmit={value => {
              if (value.trim()) quiet(withBusy($, 'search', () => runSearch($, value)))
            }}
          />
        )}

        {found.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold>Results</Text>
              <Button key="clear-results" label="clear" plain dimColor onPress={() => void update($, results, () => [])} />
            </Box>
            {found.map((x, i) => (
              <Box flexDirection="row" gap={1}>
                <Button key={`play-${i}`} label={playLabel(`play-${i}`, p?.uri === x.uri)} plain onPress={() => quiet(withBusy($, `play-${i}`, () => playPick($, x)))} />
                {x.kind === 'track' && !free ? (
                  <Button key={`queue-${i}`} label={busyText(busy, `queue-${i}`, '+', '…')} plain dimColor onPress={() => quiet(withBusy($, `queue-${i}`, () => enqueue($, x.uri, `"${x.title}"`)))} />
                ) : (
                  <Text> </Text>
                )}
                <Box flexShrink={1}>
                  <Text wrap="truncate-end">
                    {x.title}
                    <Text dimColor> — {x.subtitle}</Text>
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {queue.length > 0 && isOn(s, 'showUpNext') && (
          <Box flexDirection="column">
            <Text bold>Up next</Text>
            {queue.map((x, i) => (
              <Text wrap="truncate-end" dimColor>
                {i + 1}. {x.title} — {x.subtitle}
              </Text>
            ))}
          </Box>
        )}

        {isOn(s, 'showDevices') && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Devices</Text>
            <Button key="load-devices" label={busyText(busy, 'load-devices', 'refresh', 'refreshing…')} plain dimColor onPress={() => quiet(withBusy($, 'load-devices', () => loadDevices($)))} />
          </Box>
          {free && devs.map(d => <Text dimColor={!d.isActive}>{`${d.isActive ? '▶ ' : '  '}${d.name} (${d.type})`}</Text>)}
          {!free &&
            devs.map((d, i) => (
              <Button
                key={`dev-${i}`}
                label={busyText(busy, `dev-${i}`, `${d.isActive ? '▶ ' : '  '}${d.name} (${d.type})`, `  moving playback to ${d.name}…`)}
                plain
                dimColor={!d.isActive}
                onPress={() => quiet(withBusy($, `dev-${i}`, () => useDevice($, d.id)))}
              />
            ))}
        </Box>
        )}

        <Box>
          <Button key="logout" label={busyText(busy, 'logout', 'log out', 'logging out…')} plain dimColor onPress={() => quiet(withBusy($, 'logout', () => pressLogout($)))} />
        </Box>
      </Box>
    )
  })
}
