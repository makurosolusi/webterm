// Operasi TULIS file manager (WS-FM-01): create eksklusif, write dengan cek versi + tulis atomik,
// mkdir. Mengembalikan `FsResult` (tak melempar); penerjemahan ke HTTP ada di dispatcher `fsApi.ts`.
//
// TOCTOU: cek versi lalu rename punya jendela milidetik tempat proses lain bisa menulis (R-04,
// diterima; bukan kunci). Yang dijamin: tak ada tulis yang menimpa versi yang TIDAK dilihat
// pemanggil kecuali jendela itu, dan `create` tak pernah menimpa (kernel memutuskan lewat `wx`).
import { promises as fs, type BigIntStats } from 'node:fs'
import npath from 'node:path'
import { fsFail, type FsResult } from '../shared/fsContract'
import { canReplaceAtomically, errnoOf, failFrom, sweepStaleTmp, versionOf, writeAtomic } from './fsAtomic'
import { checkFsPath } from './fsOps'

export interface WriteOpts { expectedVersion?: string; mustExist?: boolean }

/** Atomik gagal karena izin/volume (bukan disk penuh): sisa jalan keluar adalah tulis in-place. */
const ATOMIC_FALLBACK_ERRNO = new Set(['EACCES', 'EPERM', 'EXDEV'])

/** Versi file saat ini (stat setelah tulis, supaya `mtimeNs` sudah final). */
async function currentVersion(p: string): Promise<string> {
  return versionOf(await fs.stat(p, { bigint: true }))
}

/** Ikuti symlink supaya tulis mendarat di file TARGET (rename atas link akan menggantinya). */
async function resolveTarget(t: string): Promise<{ real: string; danglingLink: boolean }> {
  try {
    return { real: await fs.realpath(t), danglingLink: false }
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err
    const isLink = await fs.lstat(t).then((s) => s.isSymbolicLink(), () => false) // lstat gagal = path memang tak ada
    return { real: t, danglingLink: isLink }
  }
}

async function statOrNull(p: string): Promise<BigIntStats | null> {
  try {
    return await fs.stat(p, { bigint: true })
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return null
    throw err
  }
}

/**
 * Tulis teks dengan cek konflik. `expectedVersion` basi -> `EVERSION` (+`current`); file hilang
 * saat `mustExist`/`expectedVersion` diberikan -> `ENOENT` (tak dibuat ulang diam-diam). Atomik
 * (temp+rename) untuk file reguler; in-place untuk hardlink/pemilik lain/dir tak writable/lintas
 * volume dan symlink putus.
 */
export async function writeFileChecked(path: string, content: string, opts: WriteOpts = {}): Promise<FsResult> {
  const t = checkFsPath(path)
  if (typeof t !== 'string') return t
  try {
    const { real, danglingLink } = await resolveTarget(t)
    const st = await statOrNull(real)
    if (st?.isDirectory()) return fsFail('EISDIR', `write failed: ${npath.basename(t)} is a directory`)
    if (!st && (opts.mustExist || opts.expectedVersion !== undefined)) return fsFail('ENOENT', `write failed: ${npath.basename(t)} no longer exists`)
    if (st && opts.expectedVersion !== undefined && versionOf(st) !== opts.expectedVersion) {
      return fsFail('EVERSION', `write failed: ${npath.basename(t)} changed on disk`, versionOf(st))
    }
    if (danglingLink || (st && !canReplaceAtomically(st))) {
      await fs.writeFile(real, content, 'utf-8')
    } else {
      try {
        await writeAtomic(real, content, st)
      } catch (err) {
        if (!st || !ATOMIC_FALLBACK_ERRNO.has(errnoOf(err))) throw err
        await fs.writeFile(real, content, 'utf-8')
      }
    }
    await sweepStaleTmp(npath.dirname(real))
    return { ok: true, version: await currentVersion(real) }
  } catch (err) {
    return failFrom('write', t, err)
  }
}

/** Buat file baru; `open(wx)` menolak nama yang sudah ada (`EEXIST`) tanpa balapan cek-lalu-tulis. */
export async function createFileExclusive(path: string, content = ''): Promise<FsResult> {
  const t = checkFsPath(path)
  if (typeof t !== 'string') return t
  try {
    const fh = await fs.open(t, 'wx', 0o666)
    try {
      await fh.writeFile(content, 'utf-8')
      await fh.sync()
    } catch (err) {
      await fs.rm(t, { force: true }) // file ini baru kita buat; jangan tinggalkan file separuh jadi
      throw err
    } finally {
      await fh.close()
    }
    return { ok: true, version: await currentVersion(t) }
  } catch (err) {
    return failFrom('create', t, err)
  }
}

/** `mkdir -p`; `created` true hanya bila direktori target benar-benar baru dibuat. */
export async function makeDirChecked(path: string): Promise<FsResult<{ created: boolean }>> {
  const t = checkFsPath(path)
  if (typeof t !== 'string') return t
  try {
    return { ok: true, created: (await fs.mkdir(t, { recursive: true })) !== undefined }
  } catch (err) {
    return failFrom('mkdir', t, err)
  }
}
