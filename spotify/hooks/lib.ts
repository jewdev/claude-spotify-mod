// Pure helpers: no engine access here, so tests and the hooks module share them.
import type { SpotifyItem, SpotifyPlayer } from '../types'

export const REDIRECT_URI = 'http://127.0.0.1:8888/callback'
export const ACCOUNTS = 'https://accounts.spotify.com'
export const API = 'https://api.spotify.com/v1'
export const SCOPES = [
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
].join(' ')

export type Tokens = { access: string; refresh: string; expiresAt: number; scope?: string }
export type Pending = { verifier: string; state: string }
export type SearchKind = 'track' | 'album' | 'artist' | 'playlist'

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
  }
}

export const PREMIUM_ONLY =
  'Playback control needs Spotify Premium. On a free account, play in the Spotify app; here you can still see what is playing, read lyrics, search, like tracks and make playlists.'

/** spotify:track:abc → https://open.spotify.com/track/abc (what a free account can open). */
export function webUrl(uri: string): string {
  const [, kind, id] = uri.split(':')
  return kind && id ? `https://open.spotify.com/${kind}/${id}` : 'https://open.spotify.com'
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function parseJson(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Pulls the code out of a pasted redirect URL, its path, or a bare code. */
export function codeFromRedirect(text: string, expectedState: string): string {
  const raw = text.trim()
  if (!raw.includes('?') && !raw.includes('code=')) return raw
  const query = new URLSearchParams(raw.slice(raw.indexOf('?') + 1))
  const error = query.get('error')
  if (error) throw new SpotifyError(`Spotify refused the login: ${error}`, 0)
  if (query.get('state') !== expectedState) throw new SpotifyError('Login state mismatch. Run /spotify login again.', 0)
  const code = query.get('code')
  if (!code) throw new SpotifyError('No code found in that URL.', 0)
  return code
}

export function friendly(status: number, message: string, reason?: string): string {
  if (reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(message))
    return 'No active Spotify device. Open Spotify on a device, or pick one with /spotify devices.'
  if (reason === 'PREMIUM_REQUIRED') return 'Spotify Premium is required for playback control.'
  if (status === 429) return 'Spotify rate limit hit; try again in a moment.'
  if (status === 403 && /not registered/i.test(message))
    return 'This Spotify account is not added to the app. Add it under User Management at developer.spotify.com.'
  return `Spotify ${status}: ${message}`
}

/** The smallest cover at least 64px wide: the art is drawn at about 20 pixels. */
function pickImage(images: any): string {
  const list: any[] = Array.isArray(images) ? images : []
  const fit = list.filter(i => (i?.width ?? 0) >= 64).sort((a, b) => a.width - b.width)[0] ?? list[0]
  return typeof fit?.url === 'string' ? fit.url : ''
}

const artistsOf = (item: any): string =>
  (item?.artists ?? []).map((a: any) => a.name).join(', ') || item?.show?.name || ''

export function toPlayer(data: any, now: number): SpotifyPlayer | null {
  const item = data?.item
  if (!data || !item) return null
  const isEpisode = item.type === 'episode'
  return {
    kind: isEpisode ? 'episode' : 'track',
    id: item.id ?? item.uri,
    uri: item.uri,
    title: item.name,
    artists: artistsOf(item),
    album: isEpisode ? item.show?.name ?? '' : item.album?.name ?? '',
    imageUrl: pickImage(isEpisode ? item.images ?? item.show?.images : item.album?.images),
    isPlaying: Boolean(data.is_playing),
    progressMs: data.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    fetchedAt: now,
    device: data.device?.name ?? '',
    volume: data.device?.volume_percent ?? null,
    shuffle: Boolean(data.shuffle_state),
    repeat: data.repeat_state ?? 'off',
    liked: null,
  }
}

export function toItem(x: any): SpotifyItem {
  const kind = x.type as SpotifyItem['kind']
  const subtitle =
    kind === 'track' ? `${artistsOf(x)} · ${x.album?.name ?? ''}`
    : kind === 'album' ? `${artistsOf(x)} · album`
    : kind === 'artist' ? 'artist'
    : kind === 'playlist' ? `playlist by ${x.owner?.display_name ?? 'unknown'}`
    : artistsOf(x)
  return { uri: x.uri, kind, title: x.name, subtitle }
}

/** `artist: daft punk` → { kind: 'artist', query: 'daft punk' }; plain text is a track. */
export function parseQuery(raw: string): { query: string; kind: SearchKind; explicit: boolean } {
  const m = /^(track|album|artist|playlist):\s*(.*)$/i.exec(raw.trim())
  return m
    ? { kind: m[1]!.toLowerCase() as SearchKind, query: m[2]!, explicit: true }
    : { kind: 'track', query: raw.trim(), explicit: false }
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function bar(progress: number, duration: number, width: number): string {
  const w = Math.max(4, width)
  const filled = duration > 0 ? Math.round((Math.min(progress, duration) / duration) * (w - 1)) : 0
  return '━'.repeat(filled) + '●' + '─'.repeat(Math.max(0, w - 1 - filled))
}

export function describe(p: SpotifyPlayer | null): string {
  if (!p) return 'Nothing is playing.'
  return (
    `${p.isPlaying ? 'Playing' : 'Paused'}: "${p.title}" by ${p.artists}${p.album ? ` (${p.album})` : ''}, ` +
    `${clock(p.progressMs)} / ${clock(p.durationMs)} on ${p.device || 'unknown device'}, volume ${p.volume ?? '?'}%, ` +
    `shuffle ${p.shuffle ? 'on' : 'off'}, repeat ${p.repeat}${p.liked ? ', in Liked Songs' : ''}.`
  )
}

export const CALLBACK_PAGE =
  '<html><body style="font-family:sans-serif;background:#121212;color:#1db954;text-align:center;padding-top:20vh">' +
  '<h1>Claude Code is connected to Spotify</h1><p style="color:#bbb">You can close this tab and go back to the terminal.</p></body></html>'

// Waits up to five minutes for one request to /callback on 127.0.0.1:8888 and prints its path.
export const POWERSHELL_LISTENER = `
$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8888)
$l.Start()
$deadline = (Get-Date).AddMinutes(5)
$page = '${CALLBACK_PAGE}'
try {
  while ((Get-Date) -lt $deadline) {
    if (-not $l.Pending()) { Start-Sleep -Milliseconds 200; continue }
    $c = $l.AcceptTcpClient()
    $c.ReceiveTimeout = 3000
    $s = $c.GetStream()
    $line = $null
    try { $line = [System.IO.StreamReader]::new($s).ReadLine() } catch {}
    $ok = $line -and $line.Contains('/callback')
    $body = if ($ok) { $page } else { 'not found' }
    $status = if ($ok) { '200 OK' } else { '404 Not Found' }
    $resp = "HTTP/1.1 $status\`r\`nContent-Type: text/html; charset=utf-8\`r\`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($body))\`r\`nConnection: close\`r\`n\`r\`n$body"
    $b = [Text.Encoding]::UTF8.GetBytes($resp)
    try { $s.Write($b, 0, $b.Length); $s.Flush() } catch {}
    $c.Close()
    if ($ok) { Write-Output $line.Split(' ')[1]; exit 0 }
  }
  exit 2
} finally { $l.Stop() }
`

export const PYTHON_LISTENER = `
import http.server, time
got = []
PAGE = ${JSON.stringify(CALLBACK_PAGE)}.encode()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        ok = '/callback' in self.path
        self.send_response(200 if ok else 404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        if ok:
            self.wfile.write(PAGE)
            got.append(self.path)
srv = http.server.HTTPServer(('127.0.0.1', 8888), H)
srv.timeout = 1
deadline = time.time() + 300
while not got and time.time() < deadline:
    srv.handle_request()
print(got[0] if got else '')
`

export const USAGE = [
  '/spotify                 open the player pane',
  '/spotify setup <id>      save your Spotify app client ID',
  '/spotify login           connect your account (opens the browser)',
  '/spotify code <url>      finish login by pasting the redirect URL',
  '/spotify logout',
  '/spotify now             what is playing',
  '/spotify play [query]    resume, or play the best match (track: / album: / artist: / playlist: prefixes)',
  '/spotify pause | toggle | next | prev',
  '/spotify vol <0-100|+N|-N>',
  '/spotify seek <seconds|m:ss>',
  '/spotify shuffle | repeat | like',
  '/spotify queue <query>   add the best track match to the queue',
  '/spotify search <query>  show results in the pane',
  '/spotify devices | device <name>',
  '/spotify band            show or hide the now-playing band',
  '/spotify lyrics          synced lyrics for the current track',
  '/spotify dj [hint]       Claude picks music for what you are working on and queues it',
  '/spotify autopilot       let the DJ re-pick as the session changes mood (on/off)',
  '/spotify recap [save [name]]  the session soundtrack; save it as a playlist',
].join('\n')
