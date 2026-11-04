// Minimal QR Code encoder for the pairing deep link (byte mode, error correction level M,
// versions 1-9 = up to 180 bytes; a t.me link is ~60). Port of the reference algorithm in Nayuki's
// MIT "QR Code generator" (nayuki.io/page/qr-code-generator-library), trimmed to what one link needs,
// so the card gets a QR without a new dependency.
// ponytail: fixed mask 0 instead of the lowest-penalty mask (any mask is valid and scannable); add
// penalty scoring if a scanner ever struggles, and more versions if links outgrow 180 bytes.

/** ECC codewords per block and block count for level M, index = version (1-9). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5]
const MAX_VERSION = 9
const MASK = 0
const ECL_M_BITS = 0

function rawModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (ver >= 7) result -= 36
  }
  return result
}

const dataCodewords = (ver: number): number => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMul(coef, factor)))
  }
  return result
}

/** Data codewords (mode, length, bytes, terminator, padding) for the smallest fitting version. */
function encodeData(bytes: Uint8Array): { ver: number; codewords: number[] } {
  let ver = 1
  while (ver <= MAX_VERSION && 4 + 8 + bytes.length * 8 > dataCodewords(ver) * 8) ver++
  if (ver > MAX_VERSION) throw new Error(`qr: ${bytes.length} bytes exceed version ${MAX_VERSION}`)
  const bits: number[] = []
  const put = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, 8)
  bytes.forEach((b) => put(b, 8))
  const capacity = dataCodewords(ver) * 8
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  return { ver, codewords }
}

/** Splits into blocks, appends Reed-Solomon ECC, interleaves. */
function addEcc(ver: number, data: number[]): number[] {
  const numBlocks = BLOCKS[ver]!
  const eccLen = ECC_PER_BLOCK[ver]!
  const raw = Math.floor(rawModules(ver) / 8)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]!)
    })
  }
  return result
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

/** QR matrix for `text` (UTF-8): `modules[y][x]` true = dark. Quiet zone not included. */
export function qrMatrix(text: string): boolean[][] {
  const { ver, codewords } = encodeData(new TextEncoder().encode(text))
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark
    fixed[y]![x] = true
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  const align = alignmentPositions(ver, size)
  align.forEach((ax, i) => align.forEach((ay, j) => {
    const last = align.length - 1
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  // Format bits (ECC level M + mask), BCH(15,5), XOR mask 0x5412.
  const fmtData = (ECL_M_BITS << 3) | MASK
  let rem = fmtData
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const fmt = ((fmtData << 10) | rem) ^ 0x5412
  const bit = (v: number, i: number): boolean => ((v >>> i) & 1) !== 0
  for (let i = 0; i <= 5; i++) set(8, i, bit(fmt, i))
  set(8, 7, bit(fmt, 6))
  set(8, 8, bit(fmt, 7))
  set(7, 8, bit(fmt, 8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(fmt, i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(fmt, i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(fmt, i))
  set(8, size - 8, true)
  if (ver >= 7) {
    let r = ver
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25)
    const vbits = (ver << 12) | r
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, bit(vbits, i))
      set(b, a, bit(vbits, i))
    }
  }
  // Data in the zigzag, then mask 0 ((x + y) % 2 === 0) on non-function modules.
  const all = addEcc(ver, codewords)
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (fixed[y]![x] || i >= all.length * 8) continue
        modules[y]![x] = bit(all[i >>> 3]!, 7 - (i & 7))
        i++
      }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && (x + y) % 2 === 0) modules[y]![x] = !modules[y]![x]
  return modules
}

/** SVG path data (one 1x1 square per dark module), offset by a `quiet`-module border. */
export function qrPath(modules: boolean[][], quiet = 4): string {
  const parts: string[] = []
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) parts.push(`M${x + quiet},${y + quiet}h1v1h-1z`)
  }))
  return parts.join('')
}
