// Minimal, safe zip extractor for the managed Chrome for Testing archive (no dependency: the
// archive is a plain store/deflate zip). Refuses any entry that would land outside `dest`.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const EOCD_MAX_SCAN = 65_557
const ZIP64_MARK = 0xffffffff
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const UNIX_HOST = 3
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const DEFAULT_FILE_MODE = 0o644
const MAX_ENTRY_BYTES = 800 * 1024 * 1024
const MAX_TOTAL_BYTES = 1_500 * 1024 * 1024

export class UnsafeArchiveError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeArchiveError' }
}

/** Absolute path of `name` under `dest`; throws when it is absolute, has `..`, a drive letter, a backslash or NUL. */
export function safeJoin(dest: string, name: string): string {
  const bad = name.includes('\0') || name.includes('\\') || name.includes(':') || isAbsolute(name) || name.split('/').includes('..')
  const root = resolve(dest)
  const out = resolve(root, name)
  if (bad || (out !== root && !out.startsWith(root + sep))) throw new UnsafeArchiveError(`archive entry escapes the destination: ${JSON.stringify(name)}`)
  return out
}

/** Extract every entry of `zip` into `dest` (created). Symlinks must be relative and point inside `dest`. */
export function extractZip(zip: Buffer, dest: string): void {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - EOCD_MAX_SCAN); i--) if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || p === ZIP64_MARK) throw new Error('zip: zip64 archives are not supported')
  mkdirSync(dest, { recursive: true })
  const root = resolve(dest)
  let total = 0
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== CEN_SIG) throw new Error(`zip: bad central directory entry ${n}`)
    const madeBy = zip.readUInt16LE(p + 4) >> 8
    const method = zip.readUInt16LE(p + 10)
    const csize = zip.readUInt32LE(p + 20)
    const usize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const next = p + 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32)
    const ext = zip.readUInt32LE(p + 38)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    p = next
    if (csize === ZIP64_MARK || usize === ZIP64_MARK || local === ZIP64_MARK) throw new Error('zip: zip64 entries are not supported')
    total += usize
    if (usize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new UnsafeArchiveError('archive is larger than the allowed size')
    const out = safeJoin(dest, name.replace(/\/$/, '') || '.')
    if (name.endsWith('/')) { mkdirSync(out, { recursive: true }); continue }
    if (zip.readUInt32LE(local) !== LOC_SIG) throw new Error(`zip: bad local header for ${name}`)
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new Error(`zip: unsupported compression method ${method} for ${name}`)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + csize)
    const data = method === METHOD_STORE ? raw : inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
    if (data.length !== usize) throw new Error(`zip: size mismatch for ${name}`)
    const mode = madeBy === UNIX_HOST ? ext >>> 16 : 0
    mkdirSync(dirname(out), { recursive: true })
    if ((mode & S_IFMT) === S_IFLNK) {
      const target = data.toString('utf8')
      const resolved = resolve(dirname(out), target)
      if (isAbsolute(target) || (resolved !== root && !resolved.startsWith(root + sep))) throw new UnsafeArchiveError(`symlink escapes the destination: ${JSON.stringify(name)}`)
      symlinkSync(target, out)
    } else {
      writeFileSync(out, data)
      chmodSync(out, (mode & 0o777) || DEFAULT_FILE_MODE)
    }
  }
}
