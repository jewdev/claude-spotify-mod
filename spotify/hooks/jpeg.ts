// A small JPEG reader for album art: it decodes only each 8x8 block's average
// (the DC coefficient), which is a picture one eighth the size, plenty for a
// cover drawn in a couple of dozen terminal cells. Baseline and progressive
// files, any chroma subsampling, restart markers. No IDCT needed.

type Component = { id: number; h: number; v: number; tq: number; dc: Int16Array; stride: number }
type Huffman = Map<number, number> // (length << 16 | code) -> symbol
type Picture = { width: number; height: number; rgb: Uint8Array }

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): Huffman {
  const table: Huffman = new Map()
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]!; i++) table.set((len << 16) | code++, symbols[k++]!)
    code <<= 1
  }
  return table
}

const isRestart = (b: number) => b >= 0xd0 && b <= 0xd7

/** Reads entropy-coded bits, skipping stuffed zero bytes and stopping at markers. */
class Bits {
  private bit = 0
  private byte = 0
  constructor(
    private data: Uint8Array,
    public pos: number,
  ) {}
  private next(): number {
    if (this.bit === 0) {
      const b = this.data[this.pos] ?? 0
      if (b === 0xff) {
        if ((this.data[this.pos + 1] ?? 0) !== 0) return 0 // a marker: feed zeros, the caller resyncs at it
        this.pos += 2
      } else this.pos++
      this.byte = b
      this.bit = 8
    }
    this.bit--
    return (this.byte >> this.bit) & 1
  }
  read(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.next()
    return v
  }
  decode(table: Huffman): number {
    let code = 0
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.next()
      const s = table.get((len << 16) | code)
      if (s !== undefined) return s
    }
    throw new Error('bad huffman code')
  }
  /** A signed value of `n` bits, as JPEG codes them. */
  receive(n: number): number {
    if (n === 0) return 0
    const v = this.read(n)
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v
  }
  /** Moves past a restart marker, dropping any bits left in the byte. */
  restart() {
    this.bit = 0
    while (this.pos < this.data.length - 1 && !(this.data[this.pos] === 0xff && isRestart(this.data[this.pos + 1]!))) this.pos++
    this.pos += 2
  }
}

/**
 * The picture at one eighth scale as packed RGB (`width * height * 3` bytes),
 * or undefined for anything it cannot read (CMYK, arithmetic coding, a broken file).
 */
export function decodeJpegEighth(data: Uint8Array): Picture | undefined {
  try {
    return decode(data)
  } catch {
    return undefined
  }
}

function decode(data: Uint8Array): Picture | undefined {
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined
  const quant: number[] = []
  const dcTables: Huffman[] = []
  const acTables: Huffman[] = []
  let comps: Component[] = []
  let width = 0
  let height = 0
  let hmax = 1
  let vmax = 1
  let mcusX = 0
  let mcusY = 0
  let progressive = false
  let restartInterval = 0
  let pos = 2
  const u16 = (p: number) => (data[p]! << 8) | data[p + 1]!

  while (pos < data.length - 1) {
    if (data[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = data[pos + 1]!
    pos += 2
    if (marker === 0xd8 || marker === 0x01 || isRestart(marker) || marker === 0xff) continue
    if (marker === 0xd9) break
    const seg = pos + 2
    const end = pos + u16(pos)

    if (marker === 0xdb) {
      for (let p = seg; p < end; ) {
        const pq = data[p]! >> 4
        quant[data[p]! & 15] = pq ? u16(p + 1) : data[p + 1]! // only the DC entry is needed
        p += 1 + (pq ? 128 : 64)
      }
    } else if (marker === 0xc4) {
      for (let p = seg; p < end; ) {
        const counts = data.subarray(p + 1, p + 17)
        const total = counts.reduce((a, b) => a + b, 0)
        const table = buildHuffman(counts, data.subarray(p + 17, p + 17 + total))
        if (data[p]! >> 4 === 0) dcTables[data[p]! & 15] = table
        else acTables[data[p]! & 15] = table
        p += 17 + total
      }
    } else if (marker === 0xdd) {
      restartInterval = u16(seg)
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) return undefined // lossless or arithmetic
      progressive = marker === 0xc2
      height = u16(seg + 1)
      width = u16(seg + 3)
      const n = data[seg + 5]!
      if (n !== 1 && n !== 3) return undefined
      comps = []
      for (let i = 0; i < n; i++) {
        const p = seg + 6 + i * 3
        comps.push({ id: data[p]!, h: data[p + 1]! >> 4, v: data[p + 1]! & 15, tq: data[p + 2]!, dc: new Int16Array(0), stride: 0 })
      }
      hmax = Math.max(...comps.map(c => c.h))
      vmax = Math.max(...comps.map(c => c.v))
      mcusX = Math.ceil(width / (8 * hmax))
      mcusY = Math.ceil(height / (8 * vmax))
      for (const c of comps) {
        c.stride = mcusX * c.h
        c.dc = new Int16Array(c.stride * mcusY * c.v)
      }
    } else if (marker === 0xda) {
      const ns = data[seg]!
      const scan = Array.from({ length: ns }, (_, i) => {
        const id = data[seg + 1 + i * 2]!
        const t = data[seg + 2 + i * 2]!
        const c = comps.find(x => x.id === id)
        if (!c) throw new Error('scan names an unknown component')
        return { c, td: t >> 4, ta: t & 15 }
      })
      const p = seg + 1 + ns * 2
      const ss = data[p]!
      const ah = data[p + 2]! >> 4
      const al = data[p + 2]! & 15
      if (ss === 0 && (!progressive || ah === 0)) {
        const bits = new Bits(data, end)
        const grid = { mcusX, mcusY, hmax, vmax, width, height }
        scanDc(bits, scan, progressive, al, restartInterval, grid, dcTables, acTables)
        pos = bits.pos
      } else pos = end
      // on to the next marker that is not a restart (any rest of this scan is skipped)
      while (pos < data.length - 1 && !(data[pos] === 0xff && data[pos + 1] !== 0 && !isRestart(data[pos + 1]!))) pos++
      continue
    }
    pos = end
  }
  if (!width || !height || !comps.length) return undefined

  // One pixel per 8x8 block of the full-resolution image
  const w = Math.ceil(width / 8)
  const h = Math.ceil(height / 8)
  const rgb = new Uint8Array(w * h * 3)
  const sample = (c: Component, x: number, y: number) => {
    const bx = Math.min(Math.floor((x * c.h) / hmax), c.stride - 1)
    const by = Math.min(Math.floor((y * c.v) / vmax), c.dc.length / c.stride - 1)
    return (c.dc[by * c.stride + bx]! * (quant[c.tq] ?? 1)) / 8 + 128
  }
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const Y = sample(comps[0]!, x, y)
      if (comps.length === 1) {
        rgb[i] = rgb[i + 1] = rgb[i + 2] = clamp(Y)
        continue
      }
      const cb = sample(comps[1]!, x, y) - 128
      const cr = sample(comps[2]!, x, y) - 128
      rgb[i] = clamp(Y + 1.402 * cr)
      rgb[i + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr)
      rgb[i + 2] = clamp(Y + 1.772 * cb)
    }
  }
  return { width: w, height: h, rgb }
}

type Grid = { mcusX: number; mcusY: number; hmax: number; vmax: number; width: number; height: number }

/** Reads one scan's DC values into each component's grid; a baseline scan's AC values are read and dropped. */
function scanDc(
  bits: Bits,
  scan: { c: Component; td: number; ta: number }[],
  progressive: boolean,
  al: number,
  restartInterval: number,
  g: Grid,
  dcTables: Huffman[],
  acTables: Huffman[],
) {
  const pred = new Map<Component, number>()
  const block = (c: Component, td: number, ta: number, index: number) => {
    const value = (pred.get(c) ?? 0) + bits.receive(bits.decode(dcTables[td]!))
    pred.set(c, value)
    if (index >= 0 && index < c.dc.length) c.dc[index] = value << al
    if (progressive) return
    for (let k = 1; k < 64; ) {
      const rs = bits.decode(acTables[ta]!)
      const s = rs & 15
      if (s === 0) {
        if (rs >> 4 !== 15) break
        k += 16
        continue
      }
      bits.read(s)
      k += (rs >> 4) + 1
    }
  }
  let count = 0
  const tick = () => {
    if (restartInterval && ++count % restartInterval === 0) {
      bits.restart()
      pred.clear()
    }
  }
  if (scan.length > 1) {
    for (let my = 0; my < g.mcusY; my++) {
      for (let mx = 0; mx < g.mcusX; mx++) {
        for (const { c, td, ta } of scan) {
          for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, td, ta, (my * c.v + v) * c.stride + mx * c.h + h)
        }
        tick()
      }
    }
    return
  }
  const { c, td, ta } = scan[0]!
  const bw = Math.ceil(Math.ceil((g.width * c.h) / g.hmax) / 8)
  const bh = Math.ceil(Math.ceil((g.height * c.v) / g.vmax) / 8)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      block(c, td, ta, y * c.stride + x)
      tick()
    }
  }
}

/** Averages packed RGB down to `size` x `size`, as hex: what the art grid draws. */
export function resampleHex(img: Picture, size: number): string {
  let out = ''
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * img.height) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / size))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * img.width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / size))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 3
          r += img.rgb[i]!
          g += img.rgb[i + 1]!
          b += img.rgb[i + 2]!
          n++
        }
      }
      for (const v of [r, g, b]) out += Math.round(v / n).toString(16).padStart(2, '0')
    }
  }
  return out
}