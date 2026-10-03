import { describe, expect, test } from 'claude-code/testing'

import { decodeJpegEighth, resampleHex } from '../hooks/jpeg'
import { PANE_PROPS, fakeSpotify, settle } from './fake'

// 32x32 covers in four flat quadrants: red, green / blue, near-white. Baseline and progressive.
const BASELINE = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5booor+fz/Xw+sKKKK/Mz/ljPzbooor/o8P7QP62KKKK/yPP1A//Z'
const PROGRESSIVE = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wgARCAAgACADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcICf/EABcBAAMBAAAAAAAAAAAAAAAAAAYHCAn/2gAMAwEAAhADEAAAAZaF/X1YAzljm0aPOjrYJHKP/8QAFBABAAAAAAAAAAAAAAAAAAAAQP/aAAgBAQABBQIH/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPwEf/8QAFBABAAAAAAAAAAAAAAAAAAAAQP/aAAgBAQAGPwIH/8QAFBABAAAAAAAAAAAAAAAAAAAAQP/aAAgBAQABPyEH/9oADAMBAAIAAwAAABAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAABA/9oACAEBAAE/EAf/2Q=='

const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))
const near = (hex: string, rgb: [number, number, number]) =>
  [0, 1, 2].every(i => Math.abs(parseInt(hex.slice(i * 2, i * 2 + 2), 16) - rgb[i]!) <= 12)

describe('album art decoder', () => {
  for (const [name, b64] of [['baseline', BASELINE], ['progressive', PROGRESSIVE]] as const) {
    test(`reads a ${name} JPEG at one pixel per 8x8 block`, () => {
      const img = decodeJpegEighth(bytes(b64))!
      expect([img.width, img.height]).toEqual([4, 4])
      const hex = resampleHex(img, 2)
      expect(near(hex.slice(0, 6), [220, 30, 30])).toBe(true)
      expect(near(hex.slice(6, 12), [30, 200, 40])).toBe(true)
      expect(near(hex.slice(12, 18), [30, 40, 220])).toBe(true)
      expect(near(hex.slice(18, 24), [240, 240, 240])).toBe(true)
    })
  }

  test('anything that is not a readable JPEG gives nothing', () => {
    expect(decodeJpegEighth(new TextEncoder().encode('not a jpeg'))).toBeUndefined()
    expect(decodeJpegEighth(new Uint8Array(0))).toBeUndefined()
  })
})

test('macOS and Linux draw the cover: curl downloads it and the mod decodes it', async ($, on) => {
  const COVER = 'https://i.scdn.co/image/cover300'
  fakeSpotify(on, undefined, 'premium', undefined, {
    env: { TMPDIR: '/tmp/' },
    player: { item: { type: 'track', id: 't1', uri: 'spotify:track:t1', name: 'Around the World', duration_ms: 180_000, artists: [{ name: 'Daft Punk' }], album: { name: 'Homework', images: [{ url: 'https://i.scdn.co/image/small', width: 64 }, { url: COVER, width: 300 }, { url: 'https://i.scdn.co/image/big', width: 640 }] } } },
  })
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('fs.read', (_$, e) => ({ value: /claude-spotify-art.jpg$/.test(e.path) ? { base64: BASELINE } : '' }) as never)
  await $.command.run({ command: 'spotify', args: 'now' } as never)
  await settle($)
  expect(runs).toContainEqual(['curl', '-sfL', '--max-time', '15', '-o', '/tmp/claude-spotify-art.jpg', COVER])
  // the cover arrives in the background: look again after a few turns
  let cover
  for (let i = 0; i < 10 && !cover; i++) {
    const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify', props: PANE_PROPS })
    cover = await pane.find({ key: 'art' })
    await pane.unmount()
    await settle($)
  }
  expect(cover).toBeDefined()
})
