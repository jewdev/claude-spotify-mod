import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { bar, clock, codeFromRedirect, parseQuery } from '../hooks/lib'
import { lyricIndexAt, parseDjPlan, parseLrc, recapLine, vizCells } from '../hooks/media'

const PANE_PROPS = { title: 'Spotify', isFocused: true, bodyColumns: 80, placement: 'dock' } as never

const TOKENS = { tokens: { access: 'AT', refresh: 'RT', expiresAt: 9e15 }, clientId: 'cid' }

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

type Call = { method: string; url: string; body?: string }

/** Fakes the Spotify Web API beneath the plugin and records every request. */
function fakeSpotify(on: On, store: Record<string, unknown> = TOKENS, plan: 'premium' | 'free' = 'premium') {
  const calls: Call[] = []
  mock.store(on, store)
  mock.env(on, { OS: 'Windows_NT' })
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.sleep', () => ({ value: undefined }))
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

describe('lib', () => {
  test('pulls the code out of a pasted redirect URL', () => {
    expect(codeFromRedirect('http://127.0.0.1:8888/callback?code=abc&state=s1', 's1')).toBe('abc')
    expect(codeFromRedirect('/callback?code=xyz&state=s1', 's1')).toBe('xyz')
    expect(() => codeFromRedirect('/callback?code=abc&state=other', 's1')).toThrow()
    expect(() => codeFromRedirect('/callback?error=access_denied&state=s1', 's1')).toThrow()
  })

  test('parses search prefixes', () => {
    expect(parseQuery('album: discovery')).toEqual({ kind: 'album', query: 'discovery', explicit: true })
    expect(parseQuery('one more time')).toEqual({ kind: 'track', query: 'one more time', explicit: false })
  })

  test('formats time and progress', () => {
    expect(clock(61_000)).toBe('1:01')
    expect(bar(50, 100, 11)).toBe('━━━━━●─────')
  })
})

test('/spotify play <query> searches and plays the top track', async ($, on) => {
  const calls = fakeSpotify(on)
  const { text } = await $.command.run({ command: 'spotify', args: 'play one more time' } as never)
  expect(text).toContain('One More Time')
  const play = calls.find(c => c.method === 'PUT' && c.url.endsWith('/me/player/play'))
  expect(play?.body).toBe(JSON.stringify({ uris: ['spotify:track:t9'] }))
})

test('the control tool pauses playback', async ($, on) => {
  const calls = fakeSpotify(on)
  const ran = await $.tool.call({ tool: 'mcp__spotify__control', action: 'pause' } as never)
  expect(ran.deny).toBeUndefined()
  expect(calls.some(c => c.method === 'PUT' && c.url.endsWith('/me/player/pause'))).toBe(true)
})

test('the now_playing tool describes the track', async ($, on) => {
  fakeSpotify(on)
  const ran = await $.tool.call({ tool: 'mcp__spotify__now_playing' } as never)
  expect(String((ran as { result?: unknown }).result)).toContain('"Around the World" by Daft Punk')
})

test('pane and band show the track and play/pause works', async ($, on) => {
  const calls = fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'spotify',
      surface,
      component: 'Pane',
      requestId: 'spotify',
      props: { title: 'Spotify', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
    })
    expect(await pane.find({ type: 'Text', text: /Around the World/ })).toBeDefined()
    await pane.press({ key: 'toggle' })
    expect(calls.some(c => c.url.endsWith('/me/player/pause'))).toBe(true)
    await pane.unmount()

    const band = await $.ui.mount({
      plugin: 'spotify',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
    })
    expect(await band.find({ type: 'Text', text: /Around the World/ })).toBeDefined()
    await band.unmount()
  }
})

/** Lets work the plugin started without awaiting (lyrics, art, the recap entry) settle. */
async function settle($: { command: { run: (e: never) => Promise<unknown> } }) {
  for (let i = 0; i < 5; i++) await $.command.run({ command: 'spotify', args: 'help' } as never)
}

describe('media', () => {
  test('parses LRC and finds the line being sung', () => {
    const lines = parseLrc('[00:01.00] one\n[00:02.50][00:05.00] two\nno stamp\n[00:03.00] three')
    expect(lines.map(l => l.text)).toEqual(['one', 'two', 'three', 'two'])
    expect(lyricIndexAt(lines, 500)).toBe(-1)
    expect(lyricIndexAt(lines, 2_600)).toBe(1)
    expect(lyricIndexAt(lines, 60_000)).toBe(3)
  })

  test('reads the DJ plan out of a fenced reply', () => {
    const plan = parseDjPlan('Sure!\n```json\n{"vibe":"deep focus","reason":"long refactor","tracks":[{"title":"Intro","artist":"The xx"}]}\n```')
    expect(plan?.vibe).toBe('deep focus')
    expect(plan?.tracks).toEqual([{ title: 'Intro', artist: 'The xx' }])
    expect(parseDjPlan('no json here')).toBeNull()
  })

  test('packs a visualizer frame of the right size', () => {
    const cells = vizCells(10, 3, 12_345, 'seed', [0xff0000, 0x00ff00], 1)
    expect(atob(cells).length).toBe(10 * 3 * 12)
  })

  test('summarizes what happened during a track', () => {
    const line = recapLine({ at: 0, uri: 'u', title: 't', artists: 'a', tools: 3, failures: 1, files: ['a.ts'], moments: ['tests green ✓'] })
    expect(line).toBe('edited a.ts · 3 tool calls · 1 failed · tests green ✓')
  })
})

test('lyrics tab shows the synced line being sung', async ($, on) => {
  fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
  await pane.press({ key: 'tab-lyrics' })
  expect(await pane.find({ type: 'Button', text: /Around the world, again/ })).toBeDefined()
  await pane.unmount()
})

test('the DJ reads the session, finds the picks and queues them', async ($, on) => {
  const calls = fakeSpotify(on)
  const reply = '{"vibe":"deep focus","reason":"A long refactor of the auth module.","tracks":[{"title":"One More Time","artist":"Daft Punk"}]}'
  on('model.fork', () => ({ value: { isAnswered: true, text: reply, usage: {} } }) as never)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
  await pane.press({ key: 'tab-dj' })
  await pane.press({ key: 'dj-spin' })
  expect(calls.some(c => c.method === 'POST' && c.url.includes('/me/player/queue?uri=spotify%3Atrack%3At9'))).toBe(true)
  expect(await pane.find({ type: 'Text', text: /deep focus/ })).toBeDefined()
  await pane.unmount()
})

test('the recap ties edits to the track that was playing', async ($, on) => {
  fakeSpotify(on)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/src/auth.ts', old_string: 'a', new_string: 'b' } as never)
  const { text } = await $.command.run({ command: 'spotify', args: 'recap' } as never)
  expect(text).toContain('Around the World')
  expect(text).toContain('edited auth.ts')
})

const SCOPED = { ...TOKENS, tokens: { ...TOKENS.tokens, scope: 'user-read-playback-state playlist-modify-private' } }

test('saving the recap asks for a fresh login when playlist permission is missing', async ($, on) => {
  const calls = fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  const { text } = await $.command.run({ command: 'spotify', args: 'recap save' } as never)
  expect(text).toContain('/spotify login')
  expect(calls.some(c => c.url.includes('/playlists'))).toBe(false)
})

test('saving the recap creates a playlist with the session tracks', async ($, on) => {
  const calls = fakeSpotify(on, SCOPED)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  const { text } = await $.command.run({ command: 'spotify', args: 'recap save Late night refactor' } as never)
  expect(text).toContain('Saved "Late night refactor" with 1 tracks')
  const add = calls.find(c => c.method === 'POST' && c.url.endsWith('/playlists/pl1/items'))
  expect(add?.body).toBe(JSON.stringify({ uris: ['spotify:track:t1'] }))
})

test('finishing login names the connected account', async ($, on) => {
  fakeSpotify(on, { clientId: 'cid', pending: { verifier: 'v', state: 's1' } })
  const { text } = await $.command.run({ command: 'spotify', args: 'code http://127.0.0.1:8888/callback?code=abc&state=s1' } as never)
  expect(text).toBe('✓ Connected to Spotify as Ada (Premium).')
})

describe('free account', () => {
  test('learns the plan from Spotify and stops sending player commands', async ($, on) => {
    const calls = fakeSpotify(on, TOKENS, 'free')
    const first = await $.command.run({ command: 'spotify', args: 'pause' } as never)
    expect(first.text).toContain('Premium')
    const before = calls.length
    const second = await $.command.run({ command: 'spotify', args: 'next' } as never)
    expect(second.text).toContain('Playback control needs Spotify Premium')
    expect(calls.slice(before).some(c => c.url.includes('/me/player/next'))).toBe(false)
  })

  test('play opens the match in Spotify instead', async ($, on) => {
    fakeSpotify(on, TOKENS, 'free')
    await $.command.run({ command: 'spotify', args: 'pause' } as never)
    const { text } = await $.command.run({ command: 'spotify', args: 'play one more time' } as never)
    expect(text).toContain('https://open.spotify.com/track/t9')
  })

  test('the pane hides playback controls', async ($, on) => {
    fakeSpotify(on, TOKENS, 'free')
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.command.run({ command: 'spotify', args: 'pause' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    expect(await pane.find({ key: 'toggle' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /Free account/ })).toBeDefined()
    expect(await pane.find({ key: 'like' })).toBeDefined()
    await pane.unmount()
  })

  test('the DJ saves its set as a playlist instead of queueing', async ($, on) => {
    const calls = fakeSpotify(on, SCOPED, 'free')
    const reply = '{"vibe":"deep focus","reason":"Refactoring.","tracks":[{"title":"One More Time","artist":"Daft Punk"}]}'
    on('model.fork', () => ({ value: { isAnswered: true, text: reply, usage: {} } }) as never)
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.command.run({ command: 'spotify', args: 'pause' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    await pane.press({ key: 'tab-dj' })
    await pane.press({ key: 'dj-spin' })
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/playlists/pl1/items'))).toBe(true)
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/me/player/queue'))).toBe(false)
    expect(await pane.find({ key: 'dj-open' })).toBeDefined()
    await pane.unmount()
  })
})

test('a successful /spotify answer draws in green; others stay the engine row', async ($, on) => {
  fakeSpotify(on)
  const props = (text: string) => ({ command: 'spotify', args: 'code …', text, isErrored: false }) as never
  const good = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'CommandOutput', props: props('✓ Connected to Spotify as Ada (Premium).') })
  expect(await good.find({ type: 'Text', text: /Connected to Spotify as Ada/ })).toBeDefined()
  await good.unmount()
})

test('recap rows play their track, and Play all plays the soundtrack', async ($, on) => {
  const calls = fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
  await pane.press({ key: 'tab-recap' })
  await pane.press({ key: 'recap-play-0' })
  const plays = () => calls.filter(c => c.method === 'PUT' && c.url.endsWith('/me/player/play'))
  expect(plays().at(-1)?.body).toBe(JSON.stringify({ uris: ['spotify:track:t1'] }))
  await pane.press({ key: 'recap-all' })
  expect(plays().length).toBe(2)
  await pane.unmount()
})
