import { describe, expect, test } from 'claude-code/testing'

import { recapStats } from '../hooks/media'
import { clean } from '../hooks/lib'
import { DEFAULT_SETTINGS, EMPTY_TASTE, artPixels, findSetting, matchOption, mergeSettings, pollDelay, rememberTaste } from '../hooks/settings'
import { PANE_PROPS, fakeSpotify, settle } from './fake'
import type { Call } from './fake'

describe('settings', () => {
  test('stored settings merge over defaults and drop what the schema lacks', () => {
    const merged = mergeSettings({ band: 'off', doneCue: 'nonsense', gone: 'x' })
    expect(merged.band).toBe('off')
    expect(merged.doneCue).toBe(DEFAULT_SETTINGS.doneCue)
    expect('gone' in merged).toBe(false)
  })

  test('options match by value or label', () => {
    const def = findSetting('DONECUE')!
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
  })

  test('taste keeps a track in one list only', () => {
    const t = rememberTaste(rememberTaste(EMPTY_TASTE, 'skipped', 'A'), 'liked', 'A')
    expect(t).toEqual({ liked: ['A'], skipped: [] })
  })

  test('/spotify set changes a setting, and so does the Settings tab', async ($, on) => {
    fakeSpotify(on)
    const { text } = await $.command.run({ command: 'spotify', args: 'set doneCue chime' } as never)
    expect(text).toBe('When Claude finishes: Chime.')
    const bad = await $.command.run({ command: 'spotify', args: 'set doneCue loud' } as never)
    expect(bad.text).toContain('is not an option')
    await $.command.run({ command: 'spotify', args: 'now' } as never)
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    await pane.press({ key: 'tab-settings' })
    await pane.press({ key: 'group-Cues' })
    await pane.select({ key: 'set-waitingCue', value: 'off' })
    const listed = await $.command.run({ command: 'spotify', args: 'set' } as never)
    expect(listed.text).toMatch(/doneCue\s+Chime/)
    expect(listed.text).toMatch(/waitingCue\s+Off/)
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
      if (script.includes('SystemSounds')) chimes.push(script.includes('Asterisk') ? 'done' : 'waiting')
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
    expect(chimes).toEqual(['done'])
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
    await $.command.run({ command: 'spotify', args: 'set waitingCue chime' } as never)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await settle($)
    expect(chimes).toEqual(['waiting'])
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

test('album art defaults to a small cover', () => {
  expect(artPixels(DEFAULT_SETTINGS)).toBe(16)
  expect(artPixels({ ...DEFAULT_SETTINGS, art: 'small' })).toBe(12)
  expect(artPixels({ ...DEFAULT_SETTINGS, art: 'large' })).toBe(24)
  expect(artPixels(mergeSettings({ art: 'auto' }))).toBe(16)
})
