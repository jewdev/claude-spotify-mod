// Pure helpers for lyrics, the cell-grid drawings, the DJ and the session recap.
import type { LyricLine, RecapEntry } from '../types'
import { clean } from './lib'

// ---------- lyrics (LRCLIB) ----------

/** Parses LRC text (`[mm:ss.xx] words`, several stamps per line allowed) into timed lines. */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (stamps.length === 0) continue
    const text = clean(raw.replace(/\[[^\]]*\]/g, ''))
    for (const m of stamps) out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Index of the line being sung at `ms`, or -1 before the first. */
export function lyricIndexAt(lines: readonly LyricLine[], ms: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.t <= ms) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

// ---------- Raster cells ----------

export const DEFAULT_COLOR = 0x01000000

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Packs [codePoint, fg, bg] triplets as a Raster's `cells` (little-endian u32). */
export function packCells(words: Uint32Array): string {
  const bytes = new Uint8Array(words.length * 4)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    bytes[i * 4] = w & 0xff
    bytes[i * 4 + 1] = (w >>> 8) & 0xff
    bytes[i * 4 + 2] = (w >>> 16) & 0xff
    bytes[i * 4 + 3] = (w >>> 24) & 0xff
  }
  return bytesToBase64(bytes)
}

/** Album art: `hex` is width*height RRGGBB pixels; two pixel rows per cell under the upper half block. */
export function artCells(hex: string, width: number, height: number): string {
  const rows = Math.floor(height / 2)
  const words = new Uint32Array(width * rows * 3)
  const px = (x: number, y: number) => parseInt(hex.slice((y * width + x) * 6, (y * width + x) * 6 + 6), 16) || 0
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) {
      const i = (r * width + x) * 3
      words[i] = 0x2580 // ▀
      words[i + 1] = px(x, r * 2)
      words[i + 2] = px(x, r * 2 + 1)
    }
  }
  return packCells(words)
}

/** Two vivid, distinct colors from the cover's pixels, for the visualizer gradient. */
export function paletteFrom(hex: string): number[] {
  const scored: { c: number; score: number; h: number }[] = []
  for (let i = 0; i + 6 <= hex.length; i += 6) {
    const c = parseInt(hex.slice(i, i + 6), 16)
    const r = (c >> 16) & 255
    const g = (c >> 8) & 255
    const b = c & 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    let h = 0
    if (max !== min) {
      h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4
      h = (h * 60 + 360) % 360
    }
    scored.push({ c, score: sat * 0.7 + (max / 255) * 0.3, h })
  }
  scored.sort((a, b) => b.score - a.score)
  const first = scored[0]
  if (!first || first.score < 0.35) return [0x1db954, 0x1ed7a0]
  const apart = (h: number) => Math.min(Math.abs(h - first.h), 360 - Math.abs(h - first.h))
  const second = scored.find(s => apart(s.h) > 40 && s.score > 0.3)
  return [first.c, second?.c ?? lighten(first.c)]
}

function lighten(c: number): number {
  const ch = (shift: number) => Math.min(255, ((c >> shift) & 255) + 90)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967295
}

const LEVELS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]

/**
 * One frame of the spectrum: decorative bars that move with the playback
 * position (seeded by the track, pulsing on a steady beat), colored bottom
 * to top along the cover's palette. `energy` 0..1 fades them on pause.
 */
export function vizCells(
  columns: number,
  rows: number,
  ms: number,
  seed: string,
  palette: readonly number[],
  energy: number,
): string {
  const words = new Uint32Array(columns * rows * 3)
  const base = hash(seed)
  const bpm = 90 + Math.round(base * 50)
  const pulse = Math.pow(1 - (((ms / 60000) * bpm) % 1), 3)
  const t = ms / 1000
  const lo = palette[0] ?? 0x1db954
  const hi = palette[1] ?? 0x1ed7a0
  for (let x = 0; x < columns; x++) {
    const f = x / Math.max(1, columns - 1)
    const p = hash(`${seed}:${x}`)
    const wave =
      0.45 * (0.5 + 0.5 * Math.sin(t * (1.3 + p * 2.1) + p * 6.28)) +
      0.35 * (0.5 + 0.5 * Math.sin(t * (3.1 + base * 2) * (0.6 + f) + x * 0.7)) +
      0.35 * pulse * (1 - f * 0.7)
    const level = Math.max(energy > 0 ? 1 : 0, Math.round(Math.min(1, wave * (1 - f * 0.45)) * energy * rows * 8))
    for (let r = 0; r < rows; r++) {
      const fromBottom = rows - 1 - r
      const i = (r * columns + x) * 3
      words[i] = LEVELS[Math.max(0, Math.min(8, level - fromBottom * 8))]!
      words[i + 1] = mix(lo, hi, rows > 1 ? fromBottom / (rows - 1) : 0)
      words[i + 2] = DEFAULT_COLOR
    }
  }
  return packCells(words)
}

// ---------- album art helper (Windows PowerShell + System.Drawing) ----------

export const ART_SIZE = 20

export function isSafeImageUrl(url: string): boolean {
  return /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(url)
}

/**
 * Downloads `url`, scales it to size×size and prints RRGGBB per pixel,
 * row-major; then, on a second line, the downloaded file as base64.
 */
export function artScript(url: string, size: number): string {
  return [
    'Add-Type -AssemblyName System.Drawing',
    `$bytes = (New-Object System.Net.WebClient).DownloadData('${url}')`,
    '$img = [System.Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bytes)))',
    `$bmp = New-Object System.Drawing.Bitmap ${size}, ${size}`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    `$g.DrawImage($img, 0, 0, ${size}, ${size})`,
    '$sb = New-Object System.Text.StringBuilder',
    `for ($y = 0; $y -lt ${size}; $y++) { for ($x = 0; $x -lt ${size}; $x++) {`,
    "  $c = $bmp.GetPixel($x, $y); [void]$sb.Append($c.R.ToString('x2') + $c.G.ToString('x2') + $c.B.ToString('x2'))",
    '} }',
    '$sb.ToString()',
    '[Convert]::ToBase64String($bytes)',
  ].join('\n')
}

// ---------- DJ ----------

export type DjPlan = { vibe: string; reason: string; tracks: { title: string; artist: string }[] }

export const DJ_INSTRUCTIONS = [
  'You are a DJ picking music for a programmer while they work with an AI coding assistant.',
  'Choose music that fits the work and its mood: deep focus for long refactors, calm for debugging frustration,',
  'upbeat for shipping and green tests. Prefer instrumental or low-vocal tracks while heads-down.',
  'Pick real, well-known tracks that exist on Spotify, from varied artists.',
  'Reply with JSON only, no prose: {"vibe": "<2-4 words>", "reason": "<one sentence on why, referring to the work>",',
  '"tracks": [{"title": "...", "artist": "..."}]}',
].join(' ')

/** Pulls the DJ's JSON out of a reply that may wrap it in prose or a code fence. */
export function parseDjPlan(text: string): DjPlan | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1))
    const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
      .filter((t: any) => typeof t?.title === 'string' && t.title.trim())
      .map((t: any) => ({ title: String(t.title).trim(), artist: String(t.artist ?? '').trim() }))
    if (tracks.length === 0) return null
    return { vibe: String(raw.vibe ?? 'mixed').slice(0, 40), reason: String(raw.reason ?? '').slice(0, 300), tracks }
  } catch {
    return null
  }
}

// ---------- recap ----------

const TEST_COMMAND = /\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|ctest)\b|cargo test|go test/i

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function recapLine(e: RecapEntry): string {
  const bits: string[] = []
  if (e.files.length) bits.push(`edited ${e.files.slice(0, 4).join(', ')}${e.files.length > 4 ? ` +${e.files.length - 4}` : ''}`)
  if (e.tools) bits.push(`${e.tools} tool call${e.tools === 1 ? '' : 's'}`)
  if (e.failures) bits.push(`${e.failures} failed`)
  bits.push(...e.moments)
  return bits.join(' · ') || 'listening'
}

export function recapText(entries: readonly RecapEntry[]): string {
  if (entries.length === 0) return 'No tracks yet this session.'
  return entries.map(e => `${hhmm(e.at)}  ♫ ${e.title} — ${e.artists}\n        ${recapLine(e)}`).join('\n')
}

export type RecapStats = {
  tracks: number
  minutes: number
  topArtist: string
  topArtistCount: number
  busiest: RecapEntry | null
  files: number
  failures: number
}

/** Listening time is the gap to the next track (capped at 10 min), the last one up to `now`. */
export function recapStats(entries: readonly RecapEntry[], now: number): RecapStats {
  const counts = new Map<string, number>()
  let ms = 0
  let busiest: RecapEntry | null = null
  const files = new Set<string>()
  let failures = 0
  entries.forEach((e, i) => {
    const end = entries[i + 1]?.at ?? now
    ms += Math.max(0, Math.min(end - e.at, 10 * 60_000))
    const artist = e.artists.split(',')[0]!.trim()
    counts.set(artist, (counts.get(artist) ?? 0) + 1)
    if (!busiest || e.tools + e.files.length * 3 > busiest.tools + busiest.files.length * 3) busiest = e
    e.files.forEach(f => files.add(f))
    failures += e.failures
  })
  let topArtist = ''
  let topArtistCount = 0
  for (const [a, n] of counts) if (n > topArtistCount) [topArtist, topArtistCount] = [a, n]
  const top = busiest as RecapEntry | null
  return {
    tracks: entries.length,
    minutes: Math.round(ms / 60_000),
    topArtist,
    topArtistCount,
    busiest: top && top.tools > 0 ? top : null,
    files: files.size,
    failures,
  }
}

/** A shareable text card of the session's soundtrack. */
export function recapCard(entries: readonly RecapEntry[], now: number): string {
  const s = recapStats(entries, now)
  const lines = [
    '♫ My Claude Code session soundtrack',
    `${s.tracks} tracks · ${s.minutes} min · ${s.files} files touched`,
    s.topArtist ? `Top artist: ${s.topArtist} (${s.topArtistCount}×)` : '',
    s.busiest ? `Most productive track: "${s.busiest.title}" by ${s.busiest.artists} (${recapLine(s.busiest)})` : '',
    '',
    ...entries.slice(-10).map(e => `${hhmm(e.at)}  ${e.title} — ${e.artists}`),
  ]
  return lines.filter((l, i) => l !== '' || i === 4).join('\n')
}

// ---------- desktop drawings (Svg) ----------

/** Album art as an SVG of square pixels, for surfaces without Raster. */
export function artSvg(hex: string, size: number, px: number): string {
  const rects: string[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = hex.slice((y * size + x) * 6, (y * size + x) * 6 + 6)
      if (c.length === 6) rects.push(`<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="#${c}"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * px}" height="${size * px}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

/** The largest SVG a surface takes (`SvgProps.source`). */
export const SVG_MAX = 131_072

/**
 * The real cover, embedded as a JPEG with rounded corners, `px` CSS pixels
 * square; undefined when it would not fit in one SVG.
 */
export function coverSvg(jpegBase64: string, px: number): string | undefined {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}">` +
    `<defs><clipPath id="r"><rect width="100" height="100" rx="6"/></clipPath></defs>` +
    `<image href="data:image/jpeg;base64,${jpegBase64}" width="100" height="100" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/></svg>`
  return svg.length <= SVG_MAX ? svg : undefined
}

// ---------- host helpers (Windows PowerShell) ----------

/** Encrypts stdin with DPAPI for the current Windows user; prints the ciphertext. */
export const DPAPI_PROTECT =
  '$t = [Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $t -AsPlainText -Force)'

/** Decrypts a DPAPI ciphertext read from stdin; prints the secret. */
export const DPAPI_UNPROTECT = [
  '$c = [Console]::In.ReadToEnd().Trim()',
  '$s = ConvertTo-SecureString $c',
  '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
].join('; ')

// ---------- host helpers (macOS Keychain, Linux Secret Service) ----------

/** Where the login sits in the system keychain: one item, named by service and account. */
export const VAULT_SERVICE = 'claude-code-spotify'
export const VAULT_ACCOUNT = 'refresh-token'

/** Spotify's refresh tokens are URL-safe; anything else is refused rather than quoted. */
export function isVaultSafe(secret: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{1,4096}$/.test(secret)
}

/**
 * The `security -i` command that saves the secret in the login keychain,
 * fed on stdin so the token never reaches a command line.
 */
export function keychainSaveInput(secret: string): string {
  return `add-generic-password -U -a ${VAULT_ACCOUNT} -s ${VAULT_SERVICE} -w "${secret}"
`
}

export const KEYCHAIN_READ = ['security', 'find-generic-password', '-a', VAULT_ACCOUNT, '-s', VAULT_SERVICE, '-w']
export const KEYCHAIN_CLEAR = ['security', 'delete-generic-password', '-a', VAULT_ACCOUNT, '-s', VAULT_SERVICE]

/** `secret-tool store` reads the secret from stdin. */
export const SECRET_TOOL_SAVE = ['secret-tool', 'store', '--label=Claude Code Spotify login', 'service', VAULT_SERVICE, 'account', VAULT_ACCOUNT]
export const SECRET_TOOL_READ = ['secret-tool', 'lookup', 'service', VAULT_SERVICE, 'account', VAULT_ACCOUNT]
export const SECRET_TOOL_CLEAR = ['secret-tool', 'clear', 'service', VAULT_SERVICE, 'account', VAULT_ACCOUNT]

/** A short system sound: `done` or `waiting`. */
/** Plays a .wav at `volume` (0..1) through Windows' media player, then waits for it to finish. */
export function soundScript(path: string, volume: number): string {
  const quoted = path.replace(/'/g, "''")
  return [
    'Add-Type -AssemblyName PresentationCore',
    '$p = New-Object System.Windows.Media.MediaPlayer',
    `$p.Open([Uri]'${quoted}')`,
    `$p.Volume = ${Math.max(0, Math.min(1, volume)).toFixed(2)}`,
    'Start-Sleep -Milliseconds 150',
    '$p.Play()',
    'Start-Sleep -Milliseconds 1400',
    '$p.Close()',
  ].join('; ')
}

export function chimeScript(kind: 'done' | 'waiting'): string {
  const sound = kind === 'done' ? 'Asterisk' : 'Exclamation'
  return `[System.Media.SystemSounds]::${sound}.Play(); Start-Sleep -Milliseconds 700`
}
