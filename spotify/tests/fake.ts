// A fake Spotify beneath the plugin, shared by the test files.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

export const PANE_PROPS = { title: 'Spotify', isFocused: true, bodyColumns: 80, placement: 'dock' } as never

export const TOKENS = { tokens: { access: 'AT', refresh: 'RT', expiresAt: 9e15 }, clientId: 'cid' }

export const SCOPED = { ...TOKENS, tokens: { ...TOKENS.tokens, scope: 'user-read-playback-state playlist-modify-private' } }

const PLAYER = {
  is_playing: true,
  progress_ms: 61_000,
  shuffle_state: false,
  repeat_state: 'off',
  device: { name: 'Desk PC', volume_percent: 40 },
  item: {
    type: 'track',
    id: 't1',
    uri: 'spotify:track:t1',
    name: 'Around the World',
    duration_ms: 180_000,
    artists: [{ name: 'Daft Punk' }],
    album: { name: 'Homework' },
  },
}

export type Call = { method: string; url: string; body?: string }

/** Fakes the Spotify Web API beneath the plugin and records every request. */
export function fakeSpotify(
  on: On,
  store: Record<string, unknown> = TOKENS,
  plan: 'premium' | 'free' = 'premium',
  withClock?: (clock: MockClock) => void,
  env: Record<string, string> = { OS: 'Windows_NT' },
) {
  const calls: Call[] & { store: Map<string, unknown> } = Object.assign([], { store: new Map(Object.entries(store)) })
  on('store.get', (_$, e) => ({ value: calls.store.get(e.key) }) as never)
  on('store.set', (_$, e) => {
    calls.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    calls.store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...calls.store.keys()] }) as never)
  mock.env(on, env)
  if (withClock) withClock(mock.clock(on, { now: 1_000 }))
  else {
    on('clock.now', () => ({ value: 1_000 }))
    on('clock.sleep', () => ({ value: undefined }))
  }
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('http.fetch', async (_$, e) => {
    const method = e.init?.method ?? 'GET'
    calls.push({ method, url: e.url, body: e.init?.body })
    const json = (status: number, body: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) },
    })
    const { hostname, pathname } = new URL(e.url)
    if (hostname === 'lrclib.net' && pathname === '/api/get') {
      return json(200, { syncedLyrics: '[00:00.50] Around the world\n[00:59.00] Around the world, again\n[01:30.00] Third line' })
    }
    if (hostname === 'accounts.spotify.com') {
      return json(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, scope: 'playlist-modify-private' })
    }
    if (pathname === '/v1/me' && method === 'GET') return json(200, { id: 'u1', display_name: 'Ada', product: plan })
    if (plan === 'free' && pathname.startsWith('/v1/me/player/') && method !== 'GET') {
      return json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } })
    }
    if (pathname === '/v1/me/playlists' && method === 'GET') {
      return json(200, { items: [{ type: 'playlist', uri: 'spotify:playlist:p1', name: 'Coding Mix', owner: { display_name: 'Ada' } }] })
    }
    if (pathname === '/v1/me/playlists' && method === 'POST') {
      return json(201, { id: 'pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } })
    }
    if (pathname === '/v1/me/player' && method === 'GET') return json(200, PLAYER)
    if (pathname === '/v1/me/player/queue') return json(200, { queue: [] })
    if (pathname.endsWith('/contains')) return json(200, [true])
    if (pathname === '/v1/search') {
      return json(200, {
        tracks: { items: [{ type: 'track', uri: 'spotify:track:t9', name: 'One More Time', artists: [{ name: 'Daft Punk' }], album: { name: 'Discovery' } }] },
      })
    }
    return json(204, undefined)
  })
  return calls
}

/** Lets work the plugin started without awaiting (lyrics, art, the recap entry, cues) settle. */
export async function settle($: { command: { run: (e: never) => Promise<unknown> } }) {
  for (let i = 0; i < 5; i++) await $.command.run({ command: 'spotify', args: 'help' } as never)
}
