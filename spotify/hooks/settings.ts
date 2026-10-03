// The settings page's schema, and the pure rules that read the settings.

export type SettingDef = {
  key: string
  group: string
  label: string
  help: string
  options: readonly { value: string; label: string }[]
  default: string
  /** A setting that names a sound gets a "test" button on the settings page. */
  isSound?: true
}

const ONOFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const

/** The sounds bundled in assets/, then Windows' own. */
export const SOUNDS = [
  { value: 'chime', label: 'Chime' },
  { value: 'bell', label: 'Bell' },
  { value: 'ding', label: 'Ding' },
  { value: 'marimba', label: 'Marimba' },
  { value: 'pop', label: 'Pop' },
  { value: 'system', label: 'Windows sound' },
] as const

const SOUND_OR_OFF = [...SOUNDS, { value: 'off', label: 'Off' }] as const
const OFF_OR_SOUND = [{ value: 'off', label: 'Off' }, ...SOUNDS] as const

/** Accent colors for titles, highlights and success lines. */
export const ACCENTS: Record<string, string> = {
  green: '#1DB954',
  blue: '#4C9BFF',
  purple: '#B57BFF',
  orange: '#FF9F43',
  pink: '#FF6FB5',
  white: '#E6E6E6',
}

export const SETTINGS: readonly SettingDef[] = [
  // General
  {
    key: 'accent', group: 'General', label: 'Accent color', help: 'Titles, highlights and success lines.', default: 'green',
    options: [{ value: 'green', label: 'Spotify green' }, { value: 'blue', label: 'Blue' }, { value: 'purple', label: 'Purple' }, { value: 'orange', label: 'Orange' }, { value: 'pink', label: 'Pink' }, { value: 'white', label: 'White' }],
  },
  {
    key: 'defaultTab', group: 'General', label: 'Open the pane on', help: 'The tab /spotify opens.', default: 'player',
    options: [{ value: 'player', label: 'Player' }, { value: 'lyrics', label: 'Lyrics' }, { value: 'dj', label: 'DJ' }, { value: 'recap', label: 'Recap' }, { value: 'library', label: 'Library' }, { value: 'last', label: 'Last used' }],
  },
  { key: 'statusLine', group: 'General', label: 'Status line', help: 'The track in the status line under the prompt.', options: ONOFF, default: 'on' },
  { key: 'trackToasts', group: 'General', label: 'Track-change toast', help: 'A toast when the track changes.', options: ONOFF, default: 'on' },
  {
    key: 'noticeFade', group: 'General', label: 'Messages fade after', help: 'How long status messages in the pane stay.', default: '6',
    options: [{ value: '3', label: '3 s' }, { value: '6', label: '6 s' }, { value: '10', label: '10 s' }, { value: 'never', label: 'Never' }],
  },
  {
    key: 'polling', group: 'General', label: 'Refresh rate', help: 'Smart: fast near the end of a track, slow when paused.', default: 'smart',
    options: [{ value: 'smart', label: 'Smart' }, { value: 'fast', label: 'Fast' }, { value: 'saver', label: 'Battery saver' }],
  },
  // Band
  { key: 'band', group: 'Band', label: 'Now-playing band', help: 'The row above the prompt with the track.', options: ONOFF, default: 'on' },
  { key: 'bandControls', group: 'Band', label: 'Controls', help: '⏮ ⏯ ⏭ ♥ ☰ in the band.', options: ONOFF, default: 'on' },
  { key: 'bandTime', group: 'Band', label: 'Time', help: 'Position and length in the band.', options: ONOFF, default: 'on' },
  { key: 'bandLyrics', group: 'Band', label: 'Lyric line', help: 'The line being sung, under the band.', options: ONOFF, default: 'on' },
  // Player
  {
    key: 'art', group: 'Player', label: 'Album art', help: 'Cover size in the Player tab.', default: 'medium',
    options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }, { value: 'off', label: 'Off' }],
  },
  { key: 'visualizer', group: 'Player', label: 'Visualizer', help: "Animated bars in the cover's colors (decorative; terminal only).", options: ONOFF, default: 'on' },
  {
    key: 'vizHeight', group: 'Player', label: 'Visualizer height', help: 'Rows of bars.', default: '5',
    options: [{ value: '3', label: '3 rows' }, { value: '5', label: '5 rows' }, { value: '8', label: '8 rows' }],
  },
  { key: 'showSearch', group: 'Player', label: 'Search box', help: 'Search in the Player tab.', options: ONOFF, default: 'on' },
  { key: 'showUpNext', group: 'Player', label: 'Up next', help: 'The next tracks in your queue.', options: ONOFF, default: 'on' },
  { key: 'showDevices', group: 'Player', label: 'Devices', help: 'Your devices, to move playback.', options: ONOFF, default: 'on' },
  { key: 'lyrics', group: 'Player', label: 'Lyrics', help: 'Fetch synced lyrics from lrclib.net.', options: ONOFF, default: 'on' },
  // Sounds
  { key: 'doneSound', group: 'Sounds', label: 'When Claude finishes', help: 'A sound when a turn ends. The music is never touched.', options: SOUND_OR_OFF, default: 'chime', isSound: true },
  {
    key: 'doneAfter', group: 'Sounds', label: '… for turns longer than', help: 'Every turn, or only longer ones.', default: '60',
    options: [{ value: '0', label: 'Every turn' }, { value: '30', label: '30 s' }, { value: '60', label: '1 min' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }],
  },
  { key: 'waitingSound', group: 'Sounds', label: 'When Claude needs you', help: 'A sound when a permission prompt or a question waits for you.', options: OFF_OR_SOUND, default: 'off', isSound: true },
  { key: 'focusSound', group: 'Sounds', label: 'Focus timer', help: 'A sound when a focus block or a break ends.', options: SOUND_OR_OFF, default: 'bell', isSound: true },
  {
    key: 'soundVolume', group: 'Sounds', label: 'Volume', help: 'Of these sounds only (not the music).', default: '75',
    options: [{ value: '25', label: '25%' }, { value: '50', label: '50%' }, { value: '75', label: '75%' }, { value: '100', label: '100%' }],
  },
  // DJ
  { key: 'autopilot', group: 'DJ', label: 'Autopilot', help: 'Re-pick music every few turns (Premium).', options: ONOFF, default: 'off' },
  {
    key: 'djTurns', group: 'DJ', label: 'Autopilot every', help: 'How many turns between autopilot picks.', default: '4',
    options: [{ value: '3', label: '3 turns' }, { value: '4', label: '4 turns' }, { value: '6', label: '6 turns' }, { value: '10', label: '10 turns' }],
  },
  { key: 'djEvents', group: 'DJ', label: 'React to tests', help: 'Calmer music when tests fail, upbeat when they pass (with autopilot).', options: ONOFF, default: 'on' },
  { key: 'djLearns', group: 'DJ', label: 'Learn my taste', help: 'Remember DJ picks you skip or like, and pick accordingly.', options: ONOFF, default: 'on' },
  {
    key: 'djCount', group: 'DJ', label: 'Set size', help: 'How many tracks the DJ picks.', default: '6',
    options: [{ value: '4', label: '4' }, { value: '6', label: '6' }, { value: '10', label: '10' }],
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
  { key: 'shareNowPlaying', group: 'Claude', label: "Tell Claude what's playing", help: 'A short note with your next prompt when the track changed.', options: ONOFF, default: 'off' },
  // Privacy
  { key: 'protectTokens', group: 'Privacy', label: 'Encrypt saved login', help: 'Keep the refresh token encrypted: Windows DPAPI, the macOS Keychain, or the Secret Service on Linux (GNOME Keyring, KWallet).', options: ONOFF, default: 'on' },
]

/** The settings page's groups, in order, with the line under each one's title. */
export const GROUP_INFO: Record<string, string> = {
  General: 'How the mod looks and behaves overall.',
  Band: 'The now-playing row above the prompt.',
  Player: 'What the Player tab shows.',
  Sounds: 'Sounds for moments in your session. They never touch the music.',
  DJ: 'Claude DJ: music picked for what you are working on.',
  Focus: 'A focus countdown and a break timer. They never touch the music.',
  Claude: 'What Claude is told about your music.',
  Privacy: 'How your Spotify login is kept.',
}

export function isToggle(def: SettingDef): boolean {
  return def.options.length === 2 && def.options.every(o => o.value === 'on' || o.value === 'off')
}

/** How many settings in `group` differ from their default. */
export function changedIn(s: Record<string, string>, group: string): number {
  return SETTINGS.filter(d => d.group === group && (s[d.key] ?? d.default) !== d.default).length
}

export type Settings = Record<string, string>

export const DEFAULT_SETTINGS: Settings = Object.fromEntries(SETTINGS.map(s => [s.key, s.default]))

/** Settings keys that were renamed, and how their old values carry over. */
const RENAMED: Record<string, (v: string) => [string, string] | undefined> = {
  doneCue: v => (v === 'off' ? ['doneSound', 'off'] : undefined),
  waitingCue: v => (v === 'chime' ? ['waitingSound', 'chime'] : undefined),
}

/** Stored settings over the defaults, dropping keys and values the schema no longer has. */
export function mergeSettings(stored: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS }
  if (stored && typeof stored === 'object') {
    const raw = stored as Record<string, unknown>
    for (const [oldKey, carry] of Object.entries(RENAMED)) {
      const v = raw[oldKey]
      const moved = typeof v === 'string' ? carry(v) : undefined
      if (moved && raw[moved[0]] === undefined) out[moved[0]] = moved[1]
    }
    for (const def of SETTINGS) {
      const v = raw[def.key]
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

export function accentOf(s: Settings): string {
  return ACCENTS[s.accent ?? 'green'] ?? ACCENTS.green!
}

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

/** Whether a turn that took `durationMs` earns the finish sound. */
export function earnsDoneSound(s: Settings, durationMs: number, isAborted: boolean): boolean {
  return !isAborted && s.doneSound !== 'off' && durationMs >= Number(s.doneAfter ?? 60) * 1000
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
