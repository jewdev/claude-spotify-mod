// The settings page's schema, and the pure rules that read the settings.

export type SettingDef = {
  key: string
  group: string
  label: string
  help: string
  options: readonly { value: string; label: string }[]
  default: string
}

const ONOFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const

export const SETTINGS: readonly SettingDef[] = [
  // General
  { key: 'band', group: 'General', label: 'Now-playing band', help: 'The row above the prompt with the track and controls.', options: ONOFF, default: 'on' },
  { key: 'bandLyrics', group: 'General', label: 'Lyric in the band', help: 'Show the line being sung under the band.', options: ONOFF, default: 'on' },
  { key: 'trackToasts', group: 'General', label: 'Track-change toast', help: 'A toast when the track changes.', options: ONOFF, default: 'on' },
  {
    key: 'noticeFade', group: 'General', label: 'Messages fade after', help: 'How long status messages in the pane stay.', default: '6',
    options: [{ value: '3', label: '3 s' }, { value: '6', label: '6 s' }, { value: '10', label: '10 s' }, { value: 'never', label: 'Never' }],
  },
  {
    key: 'polling', group: 'General', label: 'Refresh rate', help: 'Smart: fast near the end of a track, slow when paused.', default: 'smart',
    options: [{ value: 'smart', label: 'Smart' }, { value: 'fast', label: 'Fast' }, { value: 'saver', label: 'Battery saver' }],
  },
  // Player
  {
    key: 'art', group: 'Player', label: 'Album art', help: 'Cover size in the Player tab.', default: 'medium',
    options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }, { value: 'off', label: 'Off' }],
  },
  { key: 'visualizer', group: 'Player', label: 'Visualizer', help: 'Animated bars in the cover\'s colors (decorative).', options: ONOFF, default: 'on' },
  { key: 'lyrics', group: 'Player', label: 'Lyrics', help: 'Fetch synced lyrics from lrclib.net.', options: ONOFF, default: 'on' },
  // DJ
  { key: 'autopilot', group: 'DJ', label: 'Autopilot', help: 'Re-pick music every few turns (Premium).', options: ONOFF, default: 'off' },
  { key: 'djEvents', group: 'DJ', label: 'React to tests', help: 'Calmer music when tests fail, upbeat when they pass (with autopilot).', options: ONOFF, default: 'on' },
  { key: 'djLearns', group: 'DJ', label: 'Learn my taste', help: 'Remember DJ picks you skip or like, and pick accordingly.', options: ONOFF, default: 'on' },
  {
    key: 'djCount', group: 'DJ', label: 'Set size', help: 'How many tracks the DJ picks.', default: '6',
    options: [{ value: '4', label: '4' }, { value: '6', label: '6' }, { value: '10', label: '10' }],
  },
  // Cues
  {
    key: 'doneCue', group: 'Cues', label: 'When Claude finishes', help: 'A chime after a long turn ends. The music is never touched.', default: 'chime',
    options: [{ value: 'chime', label: 'Chime' }, { value: 'off', label: 'Off' }],
  },
  {
    key: 'doneAfter', group: 'Cues', label: '… if the turn took', help: 'Only cue for turns at least this long.', default: '60',
    options: [{ value: '30', label: '30 s+' }, { value: '60', label: '1 min+' }, { value: '120', label: '2 min+' }, { value: '300', label: '5 min+' }],
  },
  {
    key: 'waitingCue', group: 'Cues', label: 'When Claude needs you', help: 'A chime when a permission prompt or a question waits for you.', default: 'off',
    options: [{ value: 'chime', label: 'Chime' }, { value: 'off', label: 'Off' }],
  },
  // Focus
  {
    key: 'focusLength', group: 'Focus', label: 'Focus length', help: 'Default for /spotify focus.', default: '25',
    options: [{ value: '15', label: '15 min' }, { value: '25', label: '25 min' }, { value: '50', label: '50 min' }, { value: '90', label: '90 min' }],
  },
  {
    key: 'breakLength', group: 'Focus', label: 'Break length', help: 'A break timer after each focus block.', default: '5',
    options: [{ value: '0', label: 'No break' }, { value: '5', label: '5 min' }, { value: '10', label: '10 min' }, { value: '15', label: '15 min' }],
  },
  // Claude
  { key: 'shareNowPlaying', group: 'Claude', label: 'Tell Claude what\'s playing', help: 'A short note with your next prompt when the track changed.', options: ONOFF, default: 'off' },
  // Privacy
  { key: 'protectTokens', group: 'Privacy', label: 'Encrypt saved login', help: 'Encrypt the refresh token with Windows DPAPI (Windows only).', options: ONOFF, default: 'on' },
]

export type Settings = Record<string, string>

export const DEFAULT_SETTINGS: Settings = Object.fromEntries(SETTINGS.map(s => [s.key, s.default]))

/** Stored settings over the defaults, dropping keys and values the schema no longer has. */
export function mergeSettings(stored: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS }
  if (stored && typeof stored === 'object') {
    for (const def of SETTINGS) {
      const v = (stored as Record<string, unknown>)[def.key]
      if (typeof v === 'string' && def.options.some(o => o.value === v)) out[def.key] = v
    }
  }
  return out
}

export function findSetting(key: string): SettingDef | undefined {
  const k = key.toLowerCase()
  return SETTINGS.find(s => s.key.toLowerCase() === k)
}

/** `value` as typed (a value or a label, any case) to the option's value. */
export function matchOption(def: SettingDef, value: string): string | undefined {
  const v = value.trim().toLowerCase()
  return def.options.find(o => o.value.toLowerCase() === v || o.label.toLowerCase() === v)?.value
}

export function optionLabel(def: SettingDef, value: string): string {
  return def.options.find(o => o.value === value)?.label ?? value
}

export const on = (s: Settings, key: string) => s[key] === 'on'

// ---------- rules the settings drive ----------

/** Milliseconds until the next poll, from the refresh setting and the player's state. */
export function pollDelay(mode: string, state: { isPlaying: boolean; remainingMs: number } | null): number {
  if (mode === 'fast') return 2000
  const saver = mode === 'saver'
  if (!state) return saver ? 60_000 : 15_000
  if (!state.isPlaying) return saver ? 30_000 : 10_000
  if (state.remainingMs < 5000) return 1000
  return saver ? 6000 : 3000
}

export function noticeMs(s: Settings): number | null {
  return s.noticeFade === 'never' ? null : Number(s.noticeFade) * 1000
}

/** Pixels a side; the cover is that many columns wide and half as many rows tall. */
export function artPixels(s: Settings): number {
  if (s.art === 'off') return 0
  if (s.art === 'small') return 12
  if (s.art === 'large') return 24
  return 16
}

// ---------- taste ----------

export type Taste = { liked: string[]; skipped: string[] }

export const EMPTY_TASTE: Taste = { liked: [], skipped: [] }

export function rememberTaste(taste: Taste, kind: 'liked' | 'skipped', label: string): Taste {
  const other = kind === 'liked' ? 'skipped' : 'liked'
  return {
    ...taste,
    [kind]: [label, ...taste[kind].filter(x => x !== label)].slice(0, 15),
    [other]: taste[other].filter(x => x !== label),
  } as Taste
}

export function tasteNote(taste: Taste): string {
  const parts: string[] = []
  if (taste.liked.length) parts.push(`They liked: ${taste.liked.slice(0, 8).join('; ')}.`)
  if (taste.skipped.length) parts.push(`They skipped (avoid similar): ${taste.skipped.slice(0, 8).join('; ')}.`)
  return parts.join(' ')
}

export function clockLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
