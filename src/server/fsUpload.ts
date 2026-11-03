// Upload file manager (WS-FM-10): body mentah di-stream ke `.webterm-up-<rand>.tmp` di direktori
// tujuan lalu dipublikasikan sebagai `name` TANPA menimpa. Satu file per request (tanpa multipart).
// Invarian: tmp tak pernah tersisa pada jalur gagal mana pun (cap, abort, ENOSPC, EEXIST).
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import npath from 'node:path'
import type { Readable } from 'node:stream'
import { fsFail, type FsFail, type FsResult } from '../shared/fsContract'
import { errnoOf, failFrom, FS_NAME_MAX_BYTES, sweepStaleTmp, versionOf } from './fsAtomic'
import { checkFsPath } from './fsOps'

/** errno yang berarti filesystem tak mendukung hardlink; jatuh ke cek-lalu-rename. */
const NO_LINK_ERRNO = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'])

/** Galat nama upload yang tidak aman, atau null bila `name` sah (satu segmen, bukan `.`/`..`). */
export function uploadNameError(name: string): FsFail | null {
  if (name === '' || name === '.' || name === '..') return fsFail('EINVAL', 'upload failed: invalid file name')
  if (/[/\\\0]/.test(name)) return fsFail('EINVAL', 'upload failed: file name must not contain / \\ or NUL')
  if (Buffer.byteLength(name) > FS_NAME_MAX_BYTES) return fsFail('ENAMETOOLONG', 'upload failed: file name too long')
  return null
}

class CapExceeded extends Error {}

/** Tulis `stream` ke `fh` sambil menghitung byte; melempar `CapExceeded` begitu melewati `maxBytes`. */
async function drain(stream: Readable, fh: fs.FileHandle, maxBytes: number): Promise<void> {
  let total = 0
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buf.length
    if (total > maxBytes) throw new CapExceeded()
    await fh.write(buf)
  }
}

/** Terbitkan tmp sebagai `dest` tanpa menimpa: `link` (atomik, EEXIST), cadangan lstat+rename. */
async function publish(tmp: string, dest: string): Promise<void> {
  try {
    await fs.link(tmp, dest)
    await fs.rm(tmp, { force: true })
    return
  } catch (err) {
    if (!NO_LINK_ERRNO.has(errnoOf(err))) throw err
  }
  // ponytail: tanpa hardlink ada jendela milidetik cek-lalu-rename; cukup untuk FAT/exFAT, kunci bila perlu
  const exists = await fs.lstat(dest).then(() => true, () => false)
  if (exists) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  await fs.rename(tmp, dest)
}

/** Simpan `stream` sebagai `dir/name` (tanpa overwrite, cap `maxBytes`); tak melempar, tmp selalu dibersihkan. */
export async function uploadFile(dir: string, name: string, stream: Readable | undefined, maxBytes: number): Promise<FsResult> {
  const bad = uploadNameError(name)
  if (bad) return bad
  if (!stream) return fsFail('EINVAL', 'upload failed: missing request body')
  const d = checkFsPath(dir)
  if (typeof d !== 'string') return d
  const dest = npath.join(d, name)
  const tmp = npath.join(d, `.webterm-up-${randomBytes(6).toString('hex')}.tmp`)
  let opened = false
  try {
    const st = await fs.stat(d).catch((err: unknown) => { throw Object.assign(new Error('dir'), { code: errnoOf(err) }) })
    if (!st.isDirectory()) return fsFail('ENOTDIR', `upload failed: ${npath.basename(d)} is not a directory`)
    const fh = await fs.open(tmp, 'wx', 0o666)
    opened = true
    try {
      await drain(stream, fh, maxBytes)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await publish(tmp, dest)
    await sweepStaleTmp(d)
    return { ok: true, version: versionOf(await fs.stat(dest, { bigint: true })) }
  } catch (err) {
    if (err instanceof CapExceeded) return fsFail('ETOOLARGE', `upload failed: ${name} exceeds ${maxBytes} bytes`)
    return failFrom('upload', dest, err)
  } finally {
    // tmp sudah di-link/rename = no-op; tak dibuka (dir buruk) = tak ada yang dibersihkan
    if (opened) await fs.rm(tmp, { force: true }).catch((err) => failFrom('upload-cleanup', tmp, err))
  }
}
