# Spotify for Claude Code

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that puts Spotify inside your coding session: a player pane with album art and a visualizer, time-synced lyrics, a Claude DJ that picks music for what you're working on, and a recap of the session's soundtrack.

![The Spotify pane in Claude Code: album art, a visualizer, playback controls, up next and devices, with the now-playing band above the prompt](docs/screenshot.png)

## Features

- **Now playing everywhere**: the track in the status line, a band above the prompt with ⏮ ⏯ ⏭ ♥ and the lyric being sung, and a toast when the track changes.
- **Player pane** (`/spotify`), in four tabs:
  1. **Player**: album art drawn in the terminal, an animated spectrum in the cover's colors, playback controls with hotkeys, search, up next, and device switching.
  2. **Lyrics**: synced lyrics from [LRCLIB](https://lrclib.net) with the current line highlighted. Press a line to jump to it.
  3. **DJ**: Claude reads the session, picks a vibe and a set of tracks, says why, and plays or queues them. **Autopilot** re-picks every few turns, or when tool calls start failing.
  4. **Recap**: every track played this session next to what Claude was doing meanwhile (files edited, tool calls, tests going red or green). Save it as a playlist.
- **Tools Claude can call**: `now_playing`, `control`, `play`, `search`, `queue`, `devices`. Try asking "play something calm while we debug this".

## Requirements

- Claude Code v2.1.287 or later (mods)
- A Spotify account. Free works; Premium adds playback control ([what each gets](#free-and-premium-accounts))
- A Spotify app of your own (free; steps below)
- Album art: Windows (it's rendered with PowerShell and System.Drawing) in a terminal session. Everything else works on macOS and Linux too. Automatic login there needs `python3`; otherwise paste the redirect URL.

## Free and Premium accounts

Spotify only lets Premium accounts control playback through its API. The mod reads your plan when you log in and adapts:

| | Free | Premium |
| --- | --- | --- |
| Now playing, album art, visualizer, synced lyrics | ✓ | ✓ |
| Search, like/unlike, device list, session recap | ✓ | ✓ |
| Save the recap as a playlist | ✓ | ✓ |
| Play, pause, skip, volume, seek, shuffle, repeat, queue, switch device | Opens tracks in Spotify instead | ✓ |
| Claude DJ | Saves the set as a playlist and opens it | Plays or queues the set |
| DJ autopilot | — | ✓ |

On a free account the playback buttons are hidden, ▶ becomes ↗ (open in Spotify), and Claude's playback tools explain the limit instead of failing.

> **Note for app owners:** Spotify's development mode has its own limits. The app must be owned by a Premium account, and only users added under **User Management** can sign in. If you're on a free account, ask a Premium friend to create the app and add you, or apply for extended quota.

## Install

Add this repository as a marketplace and install the plugin:

```
/plugin marketplace add jewdev/claude-spotify-mod
/plugin install spotify@claude-spotify-mod
```

Or load it from a clone for one session:

```
git clone https://github.com/jewdev/claude-spotify-mod
claude --plugin-dir ./claude-spotify-mod/spotify
```

## Set up Spotify

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Tick **Web API**, and add the redirect URI `http://127.0.0.1:8888/callback`.
3. Copy the app's **Client ID**. No client secret is needed: login uses PKCE.
4. In Claude Code:

   ```
   /spotify setup <client-id>
   /spotify login
   ```

   Your browser opens and asks you to approve. A small local listener on `127.0.0.1:8888` catches the redirect, and you're connected. If the browser shows a connection error instead, copy its address and run `/spotify code <url>`.

You can also set the client ID in `/config` under the plugin's options.

## Commands

| Command | What it does |
| --- | --- |
| `/spotify` | Open the player pane |
| `/spotify play [query]` | Resume, or play the best match (`track:`, `album:`, `artist:`, `playlist:` prefixes) |
| `/spotify pause` · `toggle` · `next` · `prev` | Playback |
| `/spotify vol <0-100\|+N\|-N>` · `seek <s\|m:ss>` | Volume and position |
| `/spotify shuffle` · `repeat` · `like` | Toggles |
| `/spotify queue <query>` · `search <query>` | Queue the best match, or search in the pane |
| `/spotify devices` · `device <name>` | List devices, or move playback |
| `/spotify lyrics` | Synced lyrics |
| `/spotify dj [hint]` | Claude DJs for the session, e.g. `/spotify dj calm, I'm debugging` |
| `/spotify autopilot [on\|off]` | Let the DJ follow the session's mood |
| `/spotify recap [save [name]]` | The session soundtrack, or save it as a playlist |
| `/spotify recap play [n]` | Play the whole soundtrack, or its track n |
| `/spotify band` | Show or hide the band above the prompt |
| `/spotify login` · `logout` · `setup <id>` | Account |

Pane hotkeys: `1`–`4` switch tabs. On the Player tab: `p` play/pause, `n` next, `b` back, `u`/`d` volume up/down, `s` shuffle, `r` repeat, `l` like. `j` spins a DJ set, `a` toggles autopilot. On Recap: `p` plays it all, `v` saves it as a playlist, and ▶ on a row plays that track.

## Privacy and security

- Your client ID and OAuth tokens are stored by Claude Code in the plugin's store under your Claude configuration directory, never in this repository. `/spotify logout` deletes the tokens.
- The mod talks to `api.spotify.com`, `accounts.spotify.com`, and `lrclib.net` (lyrics: track name, artist, album and duration only), and downloads cover images from Spotify's CDN.
- The DJ sends a summary of your session to Claude through Claude Code's own model calls: a fork of the current conversation, or a short activity summary for autopilot. It uses your plan's usage.
- Like every mod, this code runs with your permissions. Read it before installing; `claude plugin validate spotify` lists everything it hooks and calls.

## Limitations

- The visualizer is decorative. Spotify no longer offers audio analysis to new apps, so the bars move on a steady beat seeded by the track, not the real audio.
- Apps in Spotify's development mode only work for accounts added under **User Management** in the dashboard.
- Saving playlists needs playlist permissions. If you logged in with an older version, run `/spotify login` again.

## Development

```
claude plugin validate spotify   # what the mod hooks and calls
claude plugin test spotify       # the test suite, against the engine with Spotify faked
```

The hooks module is `spotify/hooks/register.tsx`; pure helpers live in `lib.ts` (API shapes, auth) and `media.ts` (lyrics, the cell-grid drawings, the DJ, the recap). The `$.state` contract is `spotify/types/index.d.ts`.

## License

MIT
