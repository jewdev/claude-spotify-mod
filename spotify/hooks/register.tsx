import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RecapEntry, SpotifyDevice, SpotifyDj, SpotifyItem, SpotifyLyrics, SpotifyPlayer, SpotifyTab } from '../types'
import {
  ACCOUNTS,
  API,
  POWERSHELL_LISTENER,
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
  toPlayer,
} from './lib'
import type { Pending, SearchKind, Tokens } from './lib'
import {
  ART_SIZE,
  DJ_INSTRUCTIONS,
  artCells,
  artScript,
  basename,
  hhmm,
  isSafeImageUrl,
  isTestCommand,
  lyricIndexAt,
  paletteFrom,
  parseDjPlan,
  parseLrc,
  recapLine,
  recapText,
  vizCells,
} from './media'

type Engine = EngineInterface

const PANE = 'spotify'
const POLL_MS = 3000
const TICK_MS = 250
const VIZ_MS = 100
const VIZ_COLUMNS = 40
const VIZ_ROWS = 5

const authed = atom({ plugin: 'spotify', key: 'authed' } as const, false)
const player = atom({ plugin: 'spotify', key: 'player' } as const, null)
const notice = atom({ plugin: 'spotify', key: 'notice' } as const, '')
const results = atom({ plugin: 'spotify', key: 'results' } as const, [])
const upNext = atom({ plugin: 'spotify', key: 'upNext' } as const, [])
const devices = atom({ plugin: 'spotify', key: 'devices' } as const, [])
const bandHidden = atom({ plugin: 'spotify', key: 'bandHidden' } as const, false)
const paneOpen = atom({ plugin: 'spotify', key: 'paneOpen' } as const, false)
const tab = atom({ plugin: 'spotify', key: 'tab' } as const, 'player')
const pos = atom({ plugin: 'spotify', key: 'pos' } as const, 0)
const lyrics = atom({ plugin: 'spotify', key: 'lyrics' } as const, null)
const lyricIndex = atom({ plugin: 'spotify', key: 'lyricIndex' } as const, -1)
const art = atom({ plugin: 'spotify', key: 'art' } as const, null)
const IDLE_DJ: SpotifyDj = { status: 'idle', vibe: '', reason: '', picks: [], source: '', at: 0 }
const dj = atom({ plugin: 'spotify', key: 'dj' } as const, IDLE_DJ)
const autopilot = atom({ plugin: 'spotify', key: 'autopilot' } as const, false)
const recap = atom({ plugin: 'spotify', key: 'recap' } as const, [])

const TOOL_NOW = 'mcp__spotify__now_playing'
const TOOL_CONTROL = 'mcp__spotify__control'
const TOOL_PLAY = 'mcp__spotify__play'
const TOOL_SEARCH = 'mcp__spotify__search'
const TOOL_QUEUE = 'mcp__spotify__queue'
const TOOL_DEVICES = 'mcp__spotify__devices'

// Module state: reset on reload, which is fine (tokens live in $.store, the UI's values in $.state).
let configuredClientId = ''
let showBand = true
let notify = true
let polling = false
let lastTrack = ''
let loginRunning = false
let refreshing: Promise<Tokens> | null = null
let lastSecond = -1
let vizEnergy = 0
let artLoading = ''
let lyricsLoading = ''
let djRunning = false
let turnsSinceDj = 0
let turnFailures = 0
let testsFailing = false
let lastPrompt = ''
const artCache = new Map<string, { cells: string; palette: number[] }>()
const lyricsCache = new Map<string, SpotifyLyrics>()

/** Fire-and-forget: background work reports through `notice`, never as an unhandled rejection. */
function quiet(work: Promise<unknown>): void {
  work.catch(() => {})
}

// ---------- auth ----------

async function clientId($: Engine): Promise<string> {
  if (configuredClientId) return configuredClientId
  const stored = await $.store.get('clientId')
  return typeof stored === 'string' ? stored : ''
}

async function hasTokens($: Engine): Promise<boolean> {
  return (await $.store.get('tokens')) != null
}

async function logout($: Engine) {
  await $.store.delete('tokens')
  await $.store.delete('pending')
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
  await $.store.set('tokens', tokens)
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

async function refreshTokens($: Engine, tokens: Tokens): Promise<Tokens> {
  try {
    const fresh = await tokenRequest(
      $,
      { grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: await clientId($) },
      tokens.refresh,
    )
    await $.store.set('tokens', fresh)
    return fresh
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 400) await logout($)
    throw err
  } finally {
    refreshing = null
  }
}

async function accessToken($: Engine, force: boolean): Promise<string> {
  const tokens = (await $.store.get('tokens')) as Tokens | undefined
  if (!tokens) throw new SpotifyError('Not logged in. Run /spotify login.', 401, 'not_logged_in')
  if (!force && (await $.clock.now()) < tokens.expiresAt) return tokens.access
  refreshing ??= refreshTokens($, tokens)
  return (await refreshing).access
}

// ---------- browser and callback listener ----------

async function isWindows($: Engine): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

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

/** Serves the redirect URI for up to five minutes; the callback's path, or undefined. */
async function waitForCallback($: Engine): Promise<string | undefined> {
  const argv = (await isWindows($))
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_LISTENER]
    : ['python3', '-c', PYTHON_LISTENER]
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 310_000 })
    const path = stdout.trim()
    return exitCode === 0 && path.includes('/callback') ? path : undefined
  } catch {
    return undefined
  }
}

async function listenForLogin($: Engine) {
  if (loginRunning) return
  loginRunning = true
  try {
    const path = await waitForCallback($)
    if (!path) return
    await finishLogin($, path)
    await update($, notice, () => 'Connected to Spotify.')
    $.ui.toast('Spotify connected ♫')
    await refresh($, true)
  } catch (err) {
    await update($, notice, () => errText(err))
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
    throw new SpotifyError(friendly(res.status, message, err?.reason), res.status, err?.reason)
  }
  return data
}

/** A player command; with no active device, moves playback to one and retries. */
async function playerCall($: Engine, method: string, path: string, body?: unknown): Promise<void> {
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
    name: d.name,
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
    if (changed && now) quiet(onTrackChange($, now))
    if (changed && notify && now?.isPlaying && prev !== null) $.ui.toast(`♫ ${now.title} — ${now.artists}`)
    $.ui.status(now ? `${now.isPlaying ? '♫' : '⏸'} ${now.title} — ${now.artists}` : undefined)
    return now
  } catch (err) {
    if (err instanceof SpotifyError && err.reason === 'not_logged_in') await update($, authed, () => false)
    await update($, notice, () => errText(err))
    return read($, player)
  } finally {
    polling = false
  }
}

async function onTrackChange($: Engine, p: SpotifyPlayer) {
  await update($, lyricIndex, () => -1)
  const at = await $.clock.now()
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

/** Four times a second: moves the pane's clock and the current lyric line. */
async function tick($: Engine) {
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
    const idx = lyricIndexAt(l.lines, at + 300)
    if (idx !== (await read($, lyricIndex))) await update($, lyricIndex, () => idx)
  }
}

/** Ten times a second while the player tab shows: repaints the spectrum in place. */
async function vizFrame($: Engine) {
  if (!(await read($, paneOpen)) || (await read($, tab)) !== 'player') return
  const p = await read($, player)
  if (!p) return
  const target = p.isPlaying ? 1 : 0
  if (vizEnergy === 0 && target === 0) return
  vizEnergy = target > vizEnergy ? Math.min(1, vizEnergy + 0.2) : Math.max(0, vizEnergy - 0.1)
  const a = await read($, art)
  const cells = vizCells(VIZ_COLUMNS, VIZ_ROWS, await positionNow($, p), p.id, a?.palette ?? [], vizEnergy)
  try {
    await $.ui.blit({ requestId: PANE, key: 'viz', cells })
  } catch {}
}

// ---------- lyrics ----------

async function lrclib($: Engine, path: string): Promise<any> {
  const res = await $.http.fetch(`https://lrclib.net/api/${path}`, {
    headers: { 'User-Agent': 'claude-code-spotify-mod/0.2 (https://github.com/anthropics/claude-code)' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`)
  return parseJson(res.text)
}

async function loadLyrics($: Engine, p: SpotifyPlayer) {
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

// ---------- album art ----------

async function loadArt($: Engine, url: string) {
  if (!url) {
    await update($, art, () => null)
    return
  }
  const cached = artCache.get(url)
  if (cached) {
    await update($, art, () => ({ url, columns: ART_SIZE, rows: ART_SIZE / 2, ...cached }))
    return
  }
  if (artLoading === url || !isSafeImageUrl(url) || !(await isWindows($))) return
  artLoading = url
  try {
    const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', artScript(url, ART_SIZE)]
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 20_000 })
    const hex = stdout.trim()
    if (exitCode !== 0 || hex.length !== ART_SIZE * ART_SIZE * 6) return
    const drawn = { cells: artCells(hex, ART_SIZE, ART_SIZE), palette: paletteFrom(hex) }
    artCache.set(url, drawn)
    if ((await read($, player))?.imageUrl === url) {
      await update($, art, () => ({ url, columns: ART_SIZE, rows: ART_SIZE / 2, ...drawn }))
    }
  } catch {
  } finally {
    artLoading = ''
  }
}

// ---------- actions (each resolves a line describing the outcome) ----------

async function act($: Engine, done: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    await update($, notice, () => done)
    await $.clock.sleep(350)
    await refresh($, true)
    return done
  } catch (err) {
    const text = errText(err)
    await update($, notice, () => text)
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

async function setShuffle($: Engine, on: boolean) {
  return act($, `Shuffle ${on ? 'on' : 'off'}.`, () => playerCall($, 'PUT', `/me/player/shuffle?state=${on}`))
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
  return act($, want ? `Saved "${p.title}" to Liked Songs.` : `Removed "${p.title}" from Liked Songs.`, async () => {
    await setLiked($, p.uri, want)
    lastTrack = ''
  })
}

async function playPick($: Engine, item: SpotifyItem) {
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
  try {
    const { query, kind, explicit } = parseQuery(raw)
    const kinds: SearchKind[] = explicit ? [kind] : ['track', 'album', 'playlist']
    const found = await search($, query, kinds, explicit ? 8 : 4)
    await update($, results, () => found)
    await update($, notice, () => (found.length ? `${found.length} results for "${query}".` : `No results for "${query}".`))
    return found
  } catch (err) {
    await update($, notice, () => errText(err))
    return []
  }
}

async function loadDevices($: Engine): Promise<SpotifyDevice[]> {
  try {
    const list = await getDevices($)
    await update($, devices, () => list)
    return list
  } catch (err) {
    await update($, notice, () => errText(err))
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
}

async function showTab($: Engine, which: SpotifyTab) {
  await update($, tab, () => which)
}

async function pressLogin($: Engine) {
  const text = await login($)
  await update($, notice, () => text.split('\n')[0] ?? '')
}

async function pressLogout($: Engine) {
  await logout($)
  await refresh($, true)
}

// ---------- DJ ----------

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
  const ask = `${DJ_INSTRUCTIONS}\nPick ${count} tracks.${hint ? ` The user adds: "${hint}".` : ''}`
  if (source !== 'autopilot') {
    const forked = await $.model.fork({
      prompt: `${ask}\nBase the pick on what we have been working on in this conversation. Answer with the JSON only.`,
    })
    if (forked.isAnswered) return forked.text
  }
  const r = await $.model.complete({
    model: 'haiku',
    system: DJ_INSTRUCTIONS,
    prompt: `${await activitySummary($)}\n\nPick ${count} tracks.${hint ? ` The user adds: "${hint}".` : ''}`,
    maxTokens: 700,
    timeoutMs: 45_000,
  })
  if (!r.isAnswered) throw new Error(`The DJ could not answer (${r.reason}).`)
  return r.text
}

async function runDj($: Engine, source: SpotifyDj['source'], hint: string) {
  if (djRunning) return
  djRunning = true
  turnsSinceDj = 0
  const count = source === 'autopilot' ? 3 : 6
  await update($, dj, (d): SpotifyDj => ({ ...d, status: 'thinking', source }))
  try {
    const plan = parseDjPlan(await askDj($, source, hint, count))
    if (!plan) throw new Error('The DJ answered without a playlist.')
    const hits = await Promise.all(
      plan.tracks.slice(0, count).map(t => search($, `${t.title} ${t.artist}`, ['track'], 1).then(r => r[0], () => undefined)),
    )
    const picks = hits.filter((x): x is SpotifyItem => x !== undefined)
    if (picks.length === 0) throw new Error('None of the DJ picks were found on Spotify.')
    const p = await read($, player)
    if (!p?.isPlaying && source !== 'autopilot') {
      await playerCall($, 'PUT', '/me/player/play', { uris: picks.map(x => x.uri) })
    } else {
      for (const x of picks) await playerCall($, 'POST', `/me/player/queue?uri=${encodeURIComponent(x.uri)}`)
    }
    const at = await $.clock.now()
    await update($, dj, () => ({ status: 'done', vibe: plan.vibe, reason: plan.reason, picks, source, at }))
    const verb = !p?.isPlaying && source !== 'autopilot' ? 'playing' : 'queued'
    $.ui.toast(`DJ · ${plan.vibe}: ${picks.length} tracks ${verb}`)
    await update($, notice, () => `DJ ${verb} ${picks.length} tracks: ${plan.vibe}.`)
    await refresh($, true)
  } catch (err) {
    await update($, dj, (d): SpotifyDj => ({ ...d, status: 'error', reason: errText(err) }))
  } finally {
    djRunning = false
  }
}

async function setAutopilot($: Engine, on: boolean | undefined) {
  const next = await update($, autopilot, a => on ?? !a)
  await $.store.set('autopilot', next)
  return next
    ? 'DJ autopilot on: every few turns, or when things go sideways, the DJ queues music for the moment.'
    : 'DJ autopilot off.'
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

async function savePlaylist($: Engine, name: string): Promise<string> {
  const tokens = (await $.store.get('tokens')) as Tokens | undefined
  if (!tokens?.scope?.includes('playlist-modify')) return RELOGIN
  const entries = await read($, recap)
  const uris = [...new Set(entries.map(e => e.uri).filter(u => u.startsWith('spotify:track:')))]
  if (uris.length === 0) return 'Nothing to save yet: no tracks have played this session.'
  const first = entries[0]
  const title = name || `Claude Code session · ${first ? new Date(first.at).toDateString() : ''}`.trim()
  const description = `Soundtrack of a Claude Code session: ${entries.length} tracks.`
  try {
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
    const link = list.external_urls?.spotify ?? ''
    return `Saved "${title}" with ${uris.length} tracks.${link ? ` ${link}` : ''}`
  } catch (err) {
    if (err instanceof SpotifyError && (err.status === 403 || err.status === 401)) {
      return `${RELOGIN} (Spotify said: ${err.message})`
    }
    return errText(err)
  }
}

async function pressSave($: Engine) {
  await update($, notice, () => 'Saving the session as a playlist…')
  const text = await savePlaylist($, '')
  await update($, notice, () => text)
  $.ui.toast(text, { timeoutMs: 8000 })
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
      await openPane($, undefined)
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
        return 'Connected to Spotify.'
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
    case 'band': {
      const hidden = await update($, bandHidden, h => !h)
      return hidden ? 'Band hidden.' : 'Band shown.'
    }
    case 'lyrics':
    case 'lyric':
      await openPane($, 'lyrics')
      return lyricsText($)
    case 'dj':
      if (djRunning) return 'The DJ is already picking.'
      quiet(runDj($, arg ? 'hint' : 'session', arg))
      await openPane($, 'dj')
      return 'The DJ is reading the session and picking tracks…'
    case 'autopilot':
      return setAutopilot($, arg === 'on' ? true : arg === 'off' ? false : undefined)
    case 'recap': {
      if (/^save\b/i.test(arg)) return savePlaylist($, arg.replace(/^save\s*/i, ''))
      await openPane($, 'recap')
      return recapText(await read($, recap))
    }
    default:
      return `Unknown subcommand "${head}".\n\n${USAGE}`
  }
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  configuredClientId = String(options.clientId ?? '').trim()
  showBand = options.showBand !== false
  notify = options.notify !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'spotify',
      description: 'Spotify: player, lyrics, Claude DJ, session recap, and playback controls',
      argumentHint: '[play <q>|pause|next|lyrics|dj [hint]|autopilot|recap|queue <q>|search <q>|help]',
      immediate: true,
    })
    await registerTools($)
    if ((await $.store.get('autopilot')) === true) await update($, autopilot, () => true)
    quiet(refresh($, true))
    $.clock.every(POLL_MS, () => quiet(refresh($, false)))
    $.clock.every(TICK_MS, () => quiet(tick($)))
    $.clock.every(VIZ_MS, () => quiet(vizFrame($)))
    return started
  })

  on('command.run', { command: 'spotify' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, paneOpen, () => false)
    return next(e)
  })

  // The session's mood, for the recap and the DJ autopilot
  on('turn.start', async ($, e, next) => {
    if (e.text) lastPrompt = e.text
    turnFailures = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    turnsSinceDj += 1
    const due = turnsSinceDj >= 4 || turnFailures >= 3
    const p = await read($, player)
    if (due && p?.isPlaying && !djRunning && (await read($, autopilot))) quiet(runDj($, 'autopilot', ''))
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const name = String(e.tool)
    if (name.startsWith('mcp__spotify__')) return ran
    const failed = 'isError' in ran && ran.isError === true
    if (failed) turnFailures += 1
    const input = e as unknown as { file_path?: string; command?: string }
    const file = (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && input.file_path ? basename(input.file_path) : undefined
    let moment: string | undefined
    if (name === 'Bash' && input.command && isTestCommand(input.command)) {
      if (failed) {
        if (!testsFailing) moment = 'tests failed ✗'
        testsFailing = true
      } else if (testsFailing) {
        testsFailing = false
        moment = 'tests green ✓'
        $.ui.toast('Tests green ✓')
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

  // Now-playing band above the prompt, with the line being sung
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const p = await read($, player)
    if (!p || (await read($, bandHidden))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = await currentLyric($)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="#1DB954">{p.isPlaying ? '♫' : '⏸'}</Text>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold>{p.title}</Text>
              <Text dimColor> — {p.artists}</Text>
            </Text>
          </Box>
          {e.props.bodyColumns > 70 && <Text dimColor>{clock(p.progressMs)}/{clock(p.durationMs)}</Text>}
          <Button key="band-prev" label="⏮" plain onPress={() => quiet(back($))} />
          <Button key="band-toggle" label={p.isPlaying ? '⏸' : '▶'} plain onPress={() => quiet(toggle($))} />
          <Button key="band-next" label="⏭" plain onPress={() => quiet(skip($))} />
          <Button key="band-like" label={p.liked ? '♥' : '♡'} plain onPress={() => quiet(like($, undefined))} />
          <Button key="band-open" label="☰" plain dimColor onPress={() => quiet(openPane($, undefined))} />
        </Box>
        {line !== undefined && p.isPlaying && (
          <Text italic color="#1DB954" dimColor wrap="truncate-end">
            {'  ♪ '}
            {line}
          </Text>
        )}
      </Box>
    )
  })

  // Player pane: tabs for the player, lyrics, the DJ and the recap
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const width = Math.max(20, e.props.bodyColumns)
    const height = e.viewport?.rows ?? 30
    const isAuthed = await read($, authed)
    const message = await read($, notice)

    if (!isAuthed) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="#1DB954">Spotify</Text>
          <Text>Not connected.</Text>
          <Box flexDirection="column">
            <Text dimColor wrap="wrap">1. Create an app at developer.spotify.com/dashboard (Web API, redirect URI {REDIRECT_URI})</Text>
            <Text dimColor>2. /spotify setup &lt;client-id&gt;</Text>
            <Text dimColor>3. Press Log in, or run /spotify login</Text>
          </Box>
          <Box>
            <Button key="login" label="Log in" variant="primary" hotkey="l" onPress={() => quiet(pressLogin($))} />
          </Box>
          {message !== '' && <Text color="yellow" wrap="wrap">{message}</Text>}
        </Box>
      )
    }

    const current = await read($, tab)
    const p = await read($, player)
    const tabs = (
      <Box flexDirection="row" columnGap={1}>
        <Button key="tab-player" label="Player" hotkey="1" variant={current === 'player' ? 'primary' : undefined} dimColor={current !== 'player'} onPress={() => quiet(showTab($, 'player'))} />
        <Button key="tab-lyrics" label="Lyrics" hotkey="2" variant={current === 'lyrics' ? 'primary' : undefined} dimColor={current !== 'lyrics'} onPress={() => quiet(showTab($, 'lyrics'))} />
        <Button key="tab-dj" label="DJ" hotkey="3" variant={current === 'dj' ? 'primary' : undefined} dimColor={current !== 'dj'} onPress={() => quiet(showTab($, 'dj'))} />
        <Button key="tab-recap" label="Recap" hotkey="4" variant={current === 'recap' ? 'primary' : undefined} dimColor={current !== 'recap'} onPress={() => quiet(showTab($, 'recap'))} />
      </Box>
    )
    const header = p ? (
      <Text wrap="truncate-end">
        <Text color="#1DB954">{p.isPlaying ? '♫ ' : '⏸ '}</Text>
        <Text bold>{p.title}</Text>
        <Text dimColor> — {p.artists}</Text>
      </Text>
    ) : (
      <Text dimColor>Nothing playing.</Text>
    )

    // ----- lyrics tab -----
    if (current === 'lyrics') {
      const l = await read($, lyrics)
      const idx = await read($, lyricIndex)
      const room = Math.max(5, Math.min(24, height - 8))
      let body
      if (!p) body = <Text dimColor>Start a track to see its lyrics.</Text>
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
                  onPress={() => quiet(seekTo($, x.t))}
                />
              )
            })}
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
      const auto = await read($, autopilot)
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {header}
          <Box flexDirection="column">
            <Text bold>Claude DJ</Text>
            {d.status === 'idle' && <Text dimColor wrap="wrap">Picks music for what you are working on in this session, then plays or queues it.</Text>}
            {d.status === 'thinking' && <Text color="#1DB954">Reading the session and digging through crates…</Text>}
            {d.status === 'error' && <Text color="yellow" wrap="wrap">{d.reason}</Text>}
            {d.status === 'done' && (
              <Box flexDirection="column">
                <Text>
                  <Text color="#1DB954" bold>{d.vibe}</Text>
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
                  <Button key={`dj-play-${i}`} label="▶" plain onPress={() => quiet(playPick($, x))} />
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
            <Button key="dj-spin" label={d.status === 'thinking' ? 'picking…' : 'Spin a set'} hotkey="j" variant="primary" onPress={() => quiet(runDj($, 'session', ''))} />
            <Button key="dj-auto" label={`Autopilot: ${auto ? 'on' : 'off'}`} hotkey="a" onPress={() => quiet(setAutopilot($, undefined))} />
          </Box>
          <Text dimColor wrap="wrap">Autopilot re-picks every few turns, and when tool calls start failing. /spotify dj &lt;hint&gt; steers it.</Text>
          {message !== '' && <Text dimColor wrap="wrap">{message}</Text>}
        </Box>
      )
    }

    // ----- recap tab -----
    if (current === 'recap') {
      const entries = await read($, recap)
      const room = Math.max(3, Math.floor((height - 10) / 2))
      const shown = entries.slice(-room)
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text bold>Session soundtrack · {entries.length} track{entries.length === 1 ? '' : 's'}</Text>
          {entries.length === 0 && <Text dimColor>Tracks you play during this session show here, with what Claude was doing meanwhile.</Text>}
          {message !== '' && <Text color="yellow" wrap="wrap">{message}</Text>}
          <Box flexDirection="column">
            {entries.length > shown.length && <Text dimColor>… {entries.length - shown.length} earlier</Text>}
            {shown.map(x => (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text dimColor>{hhmm(x.at)} </Text>
                  <Text color="#1DB954">♫ </Text>
                  {x.title}
                  <Text dimColor> — {x.artists}</Text>
                </Text>
                <Text dimColor wrap="truncate-end">{'      '}{recapLine(x)}</Text>
              </Box>
            ))}
          </Box>
          <Box>
            <Button key="recap-save" label="Save as playlist" hotkey="v" variant="primary" onPress={() => quiet(pressSave($))} />
          </Box>
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
    const hasRaster = 'Raster' in ui
    const showArt = hasRaster && cover !== null && p !== null && cover.url === p.imageUrl && width >= 50
    const vizColumns = Math.min(VIZ_COLUMNS, width)

    const info = p ? (
      <Box flexDirection="column" flexShrink={1}>
        <Text bold color="#1DB954" wrap="truncate-end">{p.isPlaying ? '♫ ' : '⏸ '}{p.title}</Text>
        <Text wrap="truncate-end">{p.artists}</Text>
        <Text dimColor wrap="truncate-end">{p.album}</Text>
        <Text>
          <Text color="#1DB954">{bar(shownPos, p.durationMs, Math.min(30, width - (showArt ? 36 : 14)))}</Text>
          <Text dimColor> {clock(shownPos)} / {clock(p.durationMs)}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {p.device || 'unknown device'} · vol {p.volume ?? '?'}% · shuffle {p.shuffle ? 'on' : 'off'} · repeat {p.repeat}
        </Text>
        {line !== undefined && (
          <Text italic dimColor wrap="truncate-end">♪ {line}</Text>
        )}
      </Box>
    ) : (
      <Text dimColor>Nothing playing. Start Spotify on a device, search below, or press DJ.</Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {showArt && 'Raster' in ui ? (
          <Box flexDirection="row" gap={2}>
            <ui.Raster key="art" columns={cover.columns} rows={cover.rows} cells={cover.cells} />
            {info}
          </Box>
        ) : (
          info
        )}
        {p && 'Raster' in ui && (
          <ui.Raster
            key="viz"
            columns={vizColumns}
            rows={VIZ_ROWS}
            cells={vizCells(vizColumns, VIZ_ROWS, shownPos, p.id, cover?.palette ?? [], p.isPlaying ? 1 : 0)}
          />
        )}

        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="prev" label="⏮ prev" hotkey="b" onPress={() => quiet(back($))} />
          <Button key="toggle" label={p?.isPlaying ? '⏸ pause' : '▶ play'} hotkey="p" variant="primary" onPress={() => quiet(toggle($))} />
          <Button key="next" label="⏭ next" hotkey="n" onPress={() => quiet(skip($))} />
          <Button key="voldown" label="vol −" hotkey="d" onPress={() => quiet(volumeBy($, -10))} />
          <Button key="volup" label="vol +" hotkey="u" onPress={() => quiet(volumeBy($, 10))} />
          <Button key="shuffle" label={p?.shuffle ? 'shuffle on' : 'shuffle off'} hotkey="s" onPress={() => quiet(toggleShuffle($))} />
          <Button key="repeat" label={`repeat ${p?.repeat ?? 'off'}`} hotkey="r" onPress={() => quiet(cycleRepeat($))} />
          <Button key="like" label={p?.liked ? '♥ liked' : '♡ like'} hotkey="l" onPress={() => quiet(like($, undefined))} />
        </Box>

        {message !== '' && <Text dimColor wrap="wrap">{message}</Text>}

        {'Input' in ui && (
          <ui.Input
            key="search"
            label="Search"
            placeholder="song · artist: … · album: … · playlist: …"
            submitLabel="Search"
            onSubmit={value => {
              if (value.trim()) quiet(runSearch($, value))
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
                <Button key={`play-${i}`} label="▶" plain onPress={() => quiet(playPick($, x))} />
                {x.kind === 'track' ? (
                  <Button key={`queue-${i}`} label="+" plain dimColor onPress={() => quiet(enqueue($, x.uri, `"${x.title}"`))} />
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

        {queue.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Up next</Text>
            {queue.map((x, i) => (
              <Text wrap="truncate-end" dimColor>
                {i + 1}. {x.title} — {x.subtitle}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Devices</Text>
            <Button key="load-devices" label="refresh" plain dimColor onPress={() => quiet(loadDevices($))} />
          </Box>
          {devs.map((d, i) => (
            <Button
              key={`dev-${i}`}
              label={`${d.isActive ? '▶ ' : '  '}${d.name} (${d.type})`}
              plain
              dimColor={!d.isActive}
              onPress={() => quiet(useDevice($, d.id))}
            />
          ))}
        </Box>

        <Box>
          <Button key="logout" label="log out" plain dimColor onPress={() => quiet(pressLogout($))} />
        </Box>
      </Box>
    )
  })
}
