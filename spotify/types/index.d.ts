export type SpotifyPlayer = {
  kind: 'track' | 'episode'
  id: string
  uri: string
  title: string
  artists: string
  album: string
  imageUrl: string
  isPlaying: boolean
  progressMs: number
  durationMs: number
  fetchedAt: number
  device: string
  volume: number | null
  shuffle: boolean
  repeat: 'off' | 'track' | 'context'
  liked: boolean | null
}

export type SpotifyItem = {
  uri: string
  kind: 'track' | 'album' | 'artist' | 'playlist' | 'episode'
  title: string
  subtitle: string
}

export type SpotifyDevice = {
  id: string
  name: string
  type: string
  isActive: boolean
  volume: number | null
}

export type SpotifyTab = 'player' | 'lyrics' | 'dj' | 'recap'

export type LyricLine = { t: number; text: string }

export type SpotifyLyrics = {
  trackId: string
  status: 'loading' | 'synced' | 'plain' | 'instrumental' | 'missing' | 'error'
  lines: LyricLine[]
}

export type SpotifyArt = {
  url: string
  columns: number
  rows: number
  cells: string
  /** Two vivid colors pulled from the cover, 0xRRGGBB, for the visualizer. */
  palette: number[]
}

export type SpotifyDj = {
  status: 'idle' | 'thinking' | 'done' | 'error'
  vibe: string
  reason: string
  picks: SpotifyItem[]
  source: 'session' | 'hint' | 'autopilot' | ''
  at: number
  /** On a free account the set is saved as a playlist: its link. */
  link: string
}

export type RecapEntry = {
  at: number
  uri: string
  title: string
  artists: string
  tools: number
  failures: number
  files: string[]
  moments: string[]
}

declare module 'claude-code' {
  interface PluginState {
    spotify: {
      authed: boolean
      player: SpotifyPlayer | null
      notice: string
      results: SpotifyItem[]
      upNext: SpotifyItem[]
      devices: SpotifyDevice[]
      bandHidden: boolean
      paneOpen: boolean
      tab: SpotifyTab
      pos: number
      lyrics: SpotifyLyrics | null
      lyricIndex: number
      art: SpotifyArt | null
      dj: SpotifyDj
      autopilot: boolean
      recap: RecapEntry[]
      /** true Premium, false free, null not known yet. */
      premium: boolean | null
    }
  }
}
