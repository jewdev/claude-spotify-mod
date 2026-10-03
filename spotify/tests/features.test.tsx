import { describe, expect, test } from 'claude-code/testing'

import { recapStats } from '../hooks/media'
import { clean, wantsSidebarTip } from '../hooks/lib'
import { DEFAULT_SETTINGS, EMPTY_TASTE, artPixels, earnsDoneSound, findSetting, matchOption, mergeSettings, pollDelay, rememberTaste } from '../hooks/settings'
import { PANE_PROPS, fakeSpotify, settle } from './fake'
import type { Call } from './fake'

describe('settings', () => {
  test('stored settings merge over defaults and drop what the schema lacks', () => {
    const merged = mergeSettings({ band: 'off', doneSound: 'nonsense', gone: 'x' })
    expect(merged.band).toBe('off')
    expect(merged.doneSound).toBe(DEFAULT_SETTINGS.doneSound)
    expect('gone' in merged).toBe(false)
  })

  test('options match by value or label', () => {
    const def = findSetting('DONESOUND')!
    expect(matchOption(def, 'Chime')).toBe('chime')
    expect(matchOption(def, 'OFF')).toBe('off')
    expect(matchOption(def, 'loud')).toBeUndefined()
  })

  test('smart polling speeds up near the end and slows when paused', () => {
    expect(pollDelay('smart', { isPlaying: true, remainingMs: 60_000 })).toBe(3000)
    expect(pollDelay('smart', { isPlaying: true, remainingMs: 2000 })).toBe(1000)
    expect(pollDelay('smart', { isPlaying: false, remainingMs: 0 })).toBe(10_000)
    expect(pollDelay('saver', null)).toBe(60_000)
  })

  test('display text drops emoji and keeps right-to-left names in a left-to-right row', () => {
    expect(clean('Lil Peep All Songs 📱')).toBe('Lil Peep All Songs')
    expect(clean('Spanish dance hits 💃🏽🎉')).toBe('Spanish dance hits')
    expect(clean('שירים בעברית')).toBe('‎שירים בעברית')
    expect(clean('Daft Punk')).toBe('Daft Punk')
    expect(clean(clean('שירים'))).toBe(clean('שירים'))
  })

  test('taste keeps a track in one list only', () => {
    const t = rememberTaste(rememberTaste(EMPTY_TASTE, 'skipped', 'A'), 'liked', 'A')
    expect(t).toEqual({ liked: ['A'], skipped: [] })
  })

  test('/spotify set changes a setting, and so does the Settings tab', async ($, on) => {
    fakeSpotify(on)
    const { text } = await $.command.run({ command: 'spotify', args: 'set doneSound bell' } as never)
    expect(text).toBe('When Claude finishes: Bell.')
    const bad = await $.command.run({ command: 'spotify', args: 'set doneSound loud' } as never)
    expect(bad.text).toContain('is not an option')
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    await pane.press({ key: 'tab-settings' })
    await pane.press({ key: 'group-Sounds' })
    await pane.press({ key: 'set-waitingSound-pop' })
    const listed = await $.command.run({ command: 'spotify', args: 'set' } as never)
    expect(listed.text).toMatch(/doneSound\s+Bell/)
    expect(listed.text).toMatch(/waitingSound\s+Pop/)
    await pane.unmount()
  })
})

test('lyrics timing can be nudged per track', async ($, on) => {
  fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  const a = await $.command.run({ command: 'spotify', args: 'lyrics earlier' } as never)
  expect(a.text).toBe('Lyrics earlier by 0.5s.')
  const b = await $.command.run({ command: 'spotify', args: 'lyrics reset' } as never)
  expect(b.text).toBe('Lyrics timing reset.')
})

test('the focus timer starts, reports and stops', async ($, on) => {
  fakeSpotify(on)
  const start = await $.command.run({ command: 'spotify', args: 'focus 25' } as never)
  expect(start.text).toContain('Focus: 25 minutes')
  const status = await $.command.run({ command: 'spotify', args: 'focus' } as never)
  expect(status.text).toMatch(/^Focus: 25:00 left/)
  const stop = await $.command.run({ command: 'spotify', args: 'focus stop' } as never)
  expect(stop.text).toBe('Focus timer stopped.')
})

test('the library tab lists playlists to play', async ($, on) => {
  const calls = fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
  await pane.press({ key: 'tab-library' })
  await pane.press({ key: 'lib-playlists' })
  expect(await pane.find({ type: 'Text', text: /Coding Mix/ })).toBeDefined()
  await pane.press({ key: 'lib-play-0' })
  expect(calls.some(c => c.method === 'PUT' && c.body === JSON.stringify({ context_uri: 'spotify:playlist:p1' }))).toBe(true)
  await pane.unmount()
})

describe('cues', () => {

  /** Every request that would change what is playing. */
  const playback = (calls: Call[]) => calls.filter(c => c.method !== 'GET' && c.url.includes('/me/player'))

  /** Records the chime: the PowerShell run that plays a system sound. */
  function hearChimes(on: Parameters<typeof fakeSpotify>[0]) {
    const chimes: string[] = []
    on('process.run', (_$, e) => {
      const script = e.argv.join(' ')
      const wav = /assets\\(\w+)\.wav/.exec(script)
      if (wav) chimes.push(wav[1]!)
      else if (script.includes('SystemSounds')) chimes.push('system')
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    return chimes
  }

  test('a long turn ending chimes and leaves the music alone', async ($, on) => {
    const calls = fakeSpotify(on)
    const chimes = hearChimes(on)
    on('turn.complete', () => ({ text: 'done' }) as never)
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.turn.complete({ answer: 'done', durationMs: 120_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await settle($)
    expect(chimes).toEqual(['chime'])
    expect(playback(calls)).toEqual([])
  })

  test('a short turn makes no cue', async ($, on) => {
    fakeSpotify(on)
    const chimes = hearChimes(on)
    on('turn.complete', () => ({ text: 'done' }) as never)
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
    await settle($)
    expect(chimes).toEqual([])
  })

  test('a question from Claude chimes only when asked to, and never touches the music', async ($, on) => {
    const calls = fakeSpotify(on)
    const chimes = hearChimes(on)
    on('tool.call', () => ({ result: 'answered' }) as never)
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await settle($)
    expect(chimes).toEqual([])
    await $.command.run({ command: 'spotify', args: 'set waitingSound ding' } as never)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await settle($)
    expect(chimes).toEqual(['ding'])
    expect(playback(calls)).toEqual([])
  })
})

test('the focus timer never changes what is playing', async ($, on) => {
  const calls = fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await $.command.run({ command: 'spotify', args: 'focus 25' } as never)
  await settle($)
  await $.command.run({ command: 'spotify', args: 'focus stop' } as never)
  expect(calls.filter(c => c.method !== 'GET' && c.url.includes('/me/player'))).toEqual([])
})

test('the recap adds session stats', async ($, on) => {
  fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  const { text } = await $.command.run({ command: 'spotify', args: 'recap' } as never)
  expect(text).toContain('My Claude Code session soundtrack')
  expect(text).toContain('Top artist: Daft Punk')
  const stats = recapStats([{ at: 0, uri: 'u', title: 't', artists: 'A, B', tools: 2, failures: 0, files: ['x.ts'], moments: [] }], 90_000)
  expect(stats.minutes).toBe(2)
  expect(stats.topArtist).toBe('A')
})

test('opening the pane suggests the sidebar only where it would dock', () => {
  expect(wantsSidebarTip('', { isFullscreen: false, columns: 160 })).toBe(true)
  expect(wantsSidebarTip('open', { isFullscreen: false, columns: 110 })).toBe(true)
  expect(wantsSidebarTip('', { isFullscreen: true, columns: 160 })).toBe(false)
  expect(wantsSidebarTip('', { isFullscreen: false, columns: 100 })).toBe(false)
  expect(wantsSidebarTip('now', { isFullscreen: false, columns: 160 })).toBe(false)
  expect(wantsSidebarTip('', undefined)).toBe(false)
})

test('album art defaults to a small cover', () => {
  expect(artPixels(DEFAULT_SETTINGS)).toBe(16)
  expect(artPixels({ ...DEFAULT_SETTINGS, art: 'small' })).toBe(12)
  expect(artPixels({ ...DEFAULT_SETTINGS, art: 'large' })).toBe(24)
  expect(artPixels(mergeSettings({ art: 'auto' }))).toBe(16)
})

describe('customizing', () => {
  test('settings from before the rename carry over', () => {
    expect(mergeSettings({ doneCue: 'off' }).doneSound).toBe('off')
    expect(mergeSettings({ waitingCue: 'chime' }).waitingSound).toBe('chime')
    expect(mergeSettings({ doneCue: 'off', doneSound: 'bell' }).doneSound).toBe('bell')
  })

  test('the finish sound can play after every turn', () => {
    const every = { ...DEFAULT_SETTINGS, doneAfter: '0' }
    expect(earnsDoneSound(every, 2_000, false)).toBe(true)
    expect(earnsDoneSound(every, 2_000, true)).toBe(false)
    expect(earnsDoneSound(DEFAULT_SETTINGS, 2_000, false)).toBe(false)
    expect(earnsDoneSound({ ...every, doneSound: 'off' }, 2_000, false)).toBe(false)
  })

  test('the band can drop its controls', async ($, on) => {
    fakeSpotify(on)
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.command.run({ command: 'spotify', args: 'set bandControls off' } as never)
    const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never })
    expect(await band.find({ type: 'Text', text: /Around the World/ })).toBeDefined()
    expect(await band.find({ key: 'band-toggle' })).toBeUndefined()
    await band.unmount()
  })

  test('the settings page tests a sound', async ($, on) => {
    fakeSpotify(on)
    const played: string[] = []
    on('process.run', (_$, e) => {
      const wav = /assets\\(\w+)\.wav/.exec(e.argv.join(' '))
      if (wav) played.push(wav[1]!)
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    await pane.press({ key: 'tab-settings' })
    await pane.press({ key: 'group-Sounds' })
    await pane.press({ key: 'test-doneSound' })
    expect(played).toEqual(['chime'])
    await pane.unmount()
  })

  test('/spotify opens on the chosen tab', async ($, on) => {
    fakeSpotify(on)
    await $.command.run({ command: 'spotify', args: 'set defaultTab lyrics' } as never)
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    await $.command.run({ command: 'spotify', args: '' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    expect(await pane.find({ key: 'ly-earlier' })).toBeDefined()
    await pane.unmount()
  })
})

describe('saved login off Windows', () => {
  const EXPIRED = { clientId: 'cid', tokens: { access: 'AT', refresh: 'RT', expiresAt: 0 } }

  /** A fake system keychain: `security` (macOS) and/or `secret-tool` (Linux), whichever `has` names. */
  function fakeVault(on: Parameters<typeof fakeSpotify>[0], has: { security?: boolean; secretTool?: boolean }) {
    const vault: { secret?: string; argv: string[] } = { argv: [] }
    on('process.run', (_$, e) => {
      vault.argv.push(e.argv.join(' '))
      const stdin = e.init?.stdin
      const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
      const fail = { value: { exitCode: 44, stdout: '', stderr: 'not found' } } as never
      const [tool, verb] = e.argv
      if (tool === 'security' && has.security) {
        if (verb === '-i') {
          vault.secret = /-w "([^"]+)"/.exec(stdin ?? '')?.[1]
          return ok()
        }
        if (verb === 'find-generic-password') return vault.secret ? ok(`${vault.secret}
`) : fail
        if (verb === 'delete-generic-password') {
          vault.secret = undefined
          return ok()
        }
      }
      if (tool === 'secret-tool' && has.secretTool) {
        if (verb === 'store') {
          vault.secret = stdin
          return ok()
        }
        if (verb === 'lookup') return vault.secret ? ok(vault.secret) : fail
        if (verb === 'clear') {
          vault.secret = undefined
          return ok()
        }
      }
      return { value: { exitCode: 127, stdout: '', stderr: `${tool}: command not found` } } as never
    })
    return vault
  }

  test('macOS keeps the refresh token in the Keychain, off the command line, and logout removes it', async ($, on) => {
    const { store } = fakeSpotify(on, EXPIRED, 'premium', undefined, { env: {} })
    const vault = fakeVault(on, { security: true })
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    expect(vault.secret).toBe('RT2')
    expect(store.get('tokens')).toEqual({ scheme: 'keychain', expiresAt: expect.any(Number), scope: 'playlist-modify-private' })
    expect(vault.argv.some(a => a.includes('RT2'))).toBe(false)
    await $.command.run({ command: 'spotify', args: 'logout' } as never)
    expect(vault.secret).toBeUndefined()
    expect(store.get('tokens')).toBeUndefined()
  })

  test('Linux uses the Secret Service through secret-tool, and turning encryption off moves the token back', async ($, on) => {
    const { store } = fakeSpotify(on, EXPIRED, 'premium', undefined, { env: {} })
    const vault = fakeVault(on, { secretTool: true })
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    expect(vault.secret).toBe('RT2')
    expect(store.get('tokens')).toMatchObject({ scheme: 'secret-service' })
    await $.command.run({ command: 'spotify', args: 'set protectTokens off' } as never)
    await settle($)
    expect(store.get('tokens')).toMatchObject({ scheme: 'plain', refresh: 'RT2' })
    expect(vault.secret).toBeUndefined()
  })

  test('with no keychain the login is stored plain', async ($, on) => {
    const { store } = fakeSpotify(on, EXPIRED, 'premium', undefined, { env: {} })
    const vault = fakeVault(on, {})
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    expect(store.get('tokens')).toMatchObject({ scheme: 'plain', refresh: 'RT2' })
  })
})

describe('login off Windows', () => {
  /** Answers the browser opener and the listeners; `has` names the ones installed. */
  function fakeListeners(on: Parameters<typeof fakeSpotify>[0], store: Map<string, unknown>, has: string[]) {
    const ran: string[] = []
    on('process.run', (_$, e) => {
      const tool = e.argv[0]!
      ran.push(tool)
      if (tool === 'open') return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
      if (!has.includes(tool)) return { value: { exitCode: 127, stdout: '', stderr: 'not found' } } as never
      const { state } = store.get('pending') as { state: string }
      return { value: { exitCode: 0, stdout: `/callback?code=C1&state=${state}
`, stderr: '' } } as never
    })
    return ran
  }

  test('automatic login uses Perl, which macOS and Linux ship', async ($, on) => {
    const { store } = fakeSpotify(on, { clientId: 'cid' }, 'premium', undefined, { env: {} })
    const ran = fakeListeners(on, store, ['perl', 'python3'])
    await $.command.run({ command: 'spotify', args: 'login' } as never)
    for (let i = 0; i < 10 && !store.get('tokens'); i++) await settle($)
    expect(ran.slice(0, 2)).toEqual(['open', 'perl'])
    expect(store.get('tokens')).toBeDefined()
  })

  test('without Perl it falls back to Python', async ($, on) => {
    const { store } = fakeSpotify(on, { clientId: 'cid' }, 'premium', undefined, { env: {} })
    const ran = fakeListeners(on, store, ['python3'])
    await $.command.run({ command: 'spotify', args: 'login' } as never)
    for (let i = 0; i < 10 && !store.get('tokens'); i++) await settle($)
    expect(ran.slice(0, 3)).toEqual(['open', 'perl', 'python3'])
    expect(store.get('tokens')).toBeDefined()
  })
})

test('the settings page toggles, previews and marks changes, on every surface that draws it', async ($, on) => {
  fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'spotify', args: 'set reset' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface, component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    await pane.press({ key: 'tab-settings' })
    await pane.press({ key: 'group-Band' })
    expect(await pane.find({ type: 'Text', text: /⏮ ⏸ ⏭/ })).toBeDefined()
    await pane.press({ key: 'set-bandControls' })
    expect(await pane.find({ type: 'Text', text: /⏮ ⏸ ⏭/ })).toBeUndefined()
    expect(await pane.find({ type: 'Button', text: /Band •/ })).toBeDefined()
    await pane.press({ key: 'settings-reset-group' })
    expect(await pane.find({ type: 'Text', text: /⏮ ⏸ ⏭/ })).toBeDefined()
    await pane.press({ key: 'group-General' })
    expect(await pane.find({ type: 'Text', text: /Preview: ♫ Around the World/ })).toBeDefined()
    await pane.unmount()
  }
})
