/**
 * A small QR code encoder (ISO/IEC 18004): byte mode, error correction level
 * M, versions 1–9 (up to 180 bytes). Enough for an authenticator app's
 * `otpauth://` URI and for the Verify link printed on an issued sheet. Our own
 * code, so neither needs an npm package. Returns the module matrix
 * (true = dark).
 */

/** Per version (index = version - 1): blocks of [count, total codewords, data codewords] at level M. */
const BLOCKS_M: readonly (readonly number[])[] = [
  [1, 26, 16],
  [1, 44, 28],
  [1, 70, 44],
  [2, 50, 32],
  [2, 67, 43],
  [4, 43, 27],
  [4, 49, 31],
  [2, 60, 38, 2, 61, 39],
  [3, 58, 36, 2, 59, 37],
]

/** Alignment pattern centres per version. */
const ALIGN: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]]

const ECL_M = 0
const MAX_VERSION = 9

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0)
}

/** Generator polynomial coefficients (highest degree first, leading 1) for `n` error-correction codewords. */
function generator(n: number): number[] {
  let g = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] = (next[j] ?? 0) ^ (g[j] ?? 0)
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(g[j] ?? 0, EXP[i] ?? 0)
    }
    g = next
  }
  return g
}

function errorCorrection(data: readonly number[], n: number): number[] {
  const g = generator(n)
  const rem = new Array<number>(n).fill(0)
  for (const d of data) {
    const factor = d ^ (rem[0] ?? 0)
    rem.shift()
    rem.push(0)
    for (let j = 0; j < n; j++) rem[j] = (rem[j] ?? 0) ^ gfMul(g[j + 1] ?? 0, factor)
  }
  return rem
}

function bitLength(n: number): number {
  let len = 0
  while (n !== 0) {
    len++
    n >>>= 1
  }
  return len
}

function bch(data: number, gen: number, shift: number): number {
  let d = data << shift
  while (bitLength(d) - bitLength(gen) >= 0) d ^= gen << (bitLength(d) - bitLength(gen))
  return (data << shift) | d
}

const G15 = 0b10100110111
const G15_MASK = 0b101010000010010
const G18 = 0b1111100100101

function blocksOf(version: number): { total: number; data: number }[] {
  const row = BLOCKS_M[version - 1] ?? []
  const out: { total: number; data: number }[] = []
  for (let i = 0; i < row.length; i += 3) for (let k = 0; k < (row[i] ?? 0); k++) out.push({ total: row[i + 1] ?? 0, data: row[i + 2] ?? 0 })
  return out
}

function codewords(bytes: Uint8Array, version: number): number[] {
  const blocks = blocksOf(version)
  const dataCount = blocks.reduce((n, b) => n + b.data, 0)
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, 8)
  for (const b of bytes) put(b, 8)
  if (bits.length > dataCount * 8) throw new Error("Too long for a QR code here.")
  if (bits.length + 4 <= dataCount * 8) put(0, 4)
  while (bits.length % 8 !== 0) bits.push(0)
  for (let pad = 0; bits.length < dataCount * 8; pad++) put(pad % 2 === 0 ? 0xec : 0x11, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0))
  const dc: number[][] = []
  const ec: number[][] = []
  let at = 0
  for (const b of blocks) {
    const part = data.slice(at, at + b.data)
    at += b.data
    dc.push(part)
    ec.push(errorCorrection(part, b.total - b.data))
  }
  const out: number[] = []
  const maxDc = Math.max(...dc.map((d) => d.length))
  for (let i = 0; i < maxDc; i++) for (const d of dc) if (i < d.length) out.push(d[i] ?? 0)
  const maxEc = Math.max(...ec.map((e) => e.length))
  for (let i = 0; i < maxEc; i++) for (const e of ec) if (i < e.length) out.push(e[i] ?? 0)
  return out
}

function maskBit(mask: number, i: number, j: number): boolean {
  switch (mask) {
    case 0:
      return (i + j) % 2 === 0
    case 1:
      return i % 2 === 0
    case 2:
      return j % 3 === 0
    case 3:
      return (i + j) % 3 === 0
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0
  }
}

type Grid = (boolean | null)[][]

function build(version: number, words: readonly number[], mask: number): boolean[][] {
  const n = version * 4 + 17
  const m: Grid = Array.from({ length: n }, () => new Array<boolean | null>(n).fill(null))
  const set = (r: number, c: number, v: boolean) => {
    const row = m[r]
    if (row) row[c] = v
  }
  const get = (r: number, c: number) => m[r]?.[c] ?? null
  for (const [pr, pc] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        if (pr + r < 0 || pr + r >= n || pc + c < 0 || pc + c >= n) continue
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        set(pr + r, pc + c, dark)
      }
    }
  }
  const centres = ALIGN[version - 1] ?? []
  for (const ar of centres) {
    for (const ac of centres) {
      if (get(ar, ac) !== null) continue
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(ar + r, ac + c, r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0))
    }
  }
  for (let i = 8; i < n - 8; i++) {
    if (get(i, 6) === null) set(i, 6, i % 2 === 0)
    if (get(6, i) === null) set(6, i, i % 2 === 0)
  }
  const format = bch((ECL_M << 3) | mask, G15, 10) ^ G15_MASK
  for (let i = 0; i < 15; i++) {
    const bit = ((format >> i) & 1) === 1
    if (i < 6) set(i, 8, bit)
    else if (i < 8) set(i + 1, 8, bit)
    else set(n - 15 + i, 8, bit)
    if (i < 8) set(8, n - i - 1, bit)
    else if (i < 9) set(8, 15 - i, bit)
    else set(8, 15 - i - 1, bit)
  }
  set(n - 8, 8, true)
  if (version >= 7) {
    const info = bch(version, G18, 12)
    for (let i = 0; i < 18; i++) {
      const bit = ((info >> i) & 1) === 1
      set(Math.floor(i / 3), (i % 3) + n - 11, bit)
      set((i % 3) + n - 11, Math.floor(i / 3), bit)
    }
  }
  let row = n - 1
  let dir = -1
  let byte = 0
  let bitIndex = 7
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (get(row, col - c) !== null) continue
        let dark = byte < words.length ? (((words[byte] ?? 0) >>> bitIndex) & 1) === 1 : false
        if (maskBit(mask, row, col - c)) dark = !dark
        set(row, col - c, dark)
        bitIndex--
        if (bitIndex === -1) {
          byte++
          bitIndex = 7
        }
      }
      row += dir
      if (row < 0 || row >= n) {
        row -= dir
        dir = -dir
        break
      }
    }
  }
  return m.map((r) => r.map((v) => v === true))
}

/** Standard mask penalty (adjacent runs, 2×2 blocks, finder-like runs, dark balance). */
function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length
  const at = (r: number, c: number) => m[r]?.[c] === true
  let score = 0
  for (let r = 0; r < n; r++) {
    for (const line of [0, 1]) {
      let run = 1
      for (let i = 1; i < n; i++) {
        const same = line === 0 ? at(r, i) === at(r, i - 1) : at(i, r) === at(i - 1, r)
        if (same) run++
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      if (run >= 5) score += run - 2
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (at(r, c) === at(r + 1, c) && at(r, c) === at(r, c + 1) && at(r, c) === at(r + 1, c + 1)) score += 3
  const finder = [true, false, true, true, true, false, true, false, false, false, false]
  const finderRev = [...finder].reverse()
  for (let r = 0; r < n; r++) {
    for (let c = 0; c + 11 <= n; c++) {
      for (const pattern of [finder, finderRev]) {
        if (pattern.every((v, k) => at(r, c + k) === v)) score += 40
        if (pattern.every((v, k) => at(c + k, r) === v)) score += 40
      }
    }
  }
  let dark = 0
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (at(r, c)) dark++
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
  return score
}

/** The smallest version (1–9) that holds `bytes` at level M. */
export function qrVersionFor(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const dataBits = blocksOf(v).reduce((n, b) => n + b.data, 0) * 8
    if (4 + 8 + byteLength * 8 <= dataBits) return v
  }
  throw new Error("Too long for a QR code here (over 180 bytes).")
}

/** The module matrix for `text` (UTF-8, byte mode, level M). `mask` fixes the mask (tests); otherwise the lowest-penalty mask. */
export function encodeQr(text: string, options: { readonly mask?: number; readonly version?: number } = {}): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const version = options.version ?? qrVersionFor(bytes.length)
  const words = codewords(bytes, version)
  if (options.mask !== undefined) return build(version, words, options.mask)
  let best: boolean[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, words, mask)
    const s = penalty(m)
    if (s < bestScore) {
      best = m
      bestScore = s
    }
  }
  if (!best) throw new Error("Couldn't make a QR code.")
  return best
}

/** The dark modules as horizontal runs (row, first column, length), for drawing with few rectangles. */
export function qrRuns(matrix: readonly (readonly boolean[])[]): { readonly row: number; readonly col: number; readonly length: number }[] {
  const runs: { row: number; col: number; length: number }[] = []
  matrix.forEach((line, row) => {
    let start = -1
    for (let col = 0; col <= line.length; col++) {
      const dark = col < line.length && line[col] === true
      if (dark && start < 0) start = col
      if (!dark && start >= 0) {
        runs.push({ row, col: start, length: col - start })
        start = -1
      }
    }
  })
  return runs
}
