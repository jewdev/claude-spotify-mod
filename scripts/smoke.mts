// Runs the mod's platform commands for real on the machine it is on (CI runs
// it on macOS and Linux): the keychain, the Perl login listener and the album
// art download and decode. The unit tests fake these; this checks the real tools.
//
//   npx tsx scripts/smoke.mts
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeJpegEighth, resampleHex } from '../spotify/hooks/jpeg'
import { PERL_LISTENER } from '../spotify/hooks/lib'
import {
  KEYCHAIN_CLEAR,
  KEYCHAIN_READ,
  SECRET_TOOL_CLEAR,
  SECRET_TOOL_READ,
  SECRET_TOOL_SAVE,
  isVaultSafe,
  keychainSaveInput,
} from '../spotify/hooks/media'

const COVER = 'https://i.scdn.co/image/ab67616d00001e02de3c04b5fc750b68899b20a9'
let failed = false

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed = true
}

function run(argv: string[], input?: string) {
  const r = spawnSync(argv[0]!, argv.slice(1), { input, encoding: 'utf8', timeout: 30_000 })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function keychain() {
  // shaped like a Spotify refresh token: URL-safe, with - and _
  const secret = `AQ${Array.from({ length: 120 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[Math.floor(Math.random() * 64)]).join('')}`
  check('token is vault-safe', isVaultSafe(secret))
  if (process.platform === 'darwin') {
    run(['security', '-i'], keychainSaveInput(secret))
    check('Keychain saves and reads back the token', run(KEYCHAIN_READ).out === secret)
    run(KEYCHAIN_CLEAR)
    check('Keychain forgets it on logout', run(KEYCHAIN_READ).code !== 0)
  } else if (process.platform === 'linux') {
    const saved = run(SECRET_TOOL_SAVE, secret)
    check('Secret Service stores the token', saved.code === 0, saved.err)
    check('Secret Service reads it back', run(SECRET_TOOL_READ).out === secret)
    run(SECRET_TOOL_CLEAR)
    check('Secret Service forgets it on logout', run(SECRET_TOOL_READ).out === '')
  }
}

async function listener() {
  const child = spawn('perl', ['-e', PERL_LISTENER])
  let out = ''
  child.stdout.on('data', d => (out += d))
  const exited = new Promise<number | null>(resolve => child.on('exit', resolve))
  await new Promise(r => setTimeout(r, 1000))
  const other = await fetch('http://127.0.0.1:8888/favicon.ico')
  check('listener answers other paths with 404', other.status === 404, String(other.status))
  const back = await fetch('http://127.0.0.1:8888/callback?code=C1&state=S1')
  const page = await back.text()
  check('listener shows the connected page', back.status === 200 && page.includes('connected to Spotify'))
  const code = await exited
  check('listener prints the callback path and exits', code === 0 && out.trim() === '/callback?code=C1&state=S1', out.trim())
}

function art() {
  const file = join(tmpdir(), 'claude-spotify-art.jpg')
  const got = run(['curl', '-sfL', '--max-time', '15', '-o', file, COVER])
  check('curl downloads the cover', got.code === 0, got.err)
  if (got.code !== 0) return
  const img = decodeJpegEighth(new Uint8Array(readFileSync(file)))
  rmSync(file, { force: true })
  check('the cover decodes', !!img && img.width >= 24 && img.height >= 24, img ? `${img.width}x${img.height}` : 'undefined')
  if (img) check('the art grid has every pixel', resampleHex(img, 24).length === 24 * 24 * 6)
}

keychain()
await listener()
art()
process.exit(failed ? 1 : 0)
