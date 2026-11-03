// Operasi MUTASI file manager (WS-FM-04): delete (trash/permanen), restore, rename, copy.
// Mengembalikan `FsResult` (tak melempar); flag MUTATE dijaga dispatcher `fsApi.ts`.
//
// Keamanan: semua path lewat `checkFsPath` (absolut, tanpa NUL, nama <=255 byte) lalu `locate`
// (kanonik = realpath induk + nama akhir; symlink di nama akhir TIDAK diikuti, jadi hapus/rename
// memperlakukan link sebagai link). `rm` hanya dipanggil atas path target yang sudah lolos penjagaan,
// atas salinan setengah jadi yang kita buat sendiri, dan di dalam `<trash>/<id>` (lihat fsTrash.ts).
// TOCTOU cek-lalu-rename (rename/restore tanpa overwrite) diterima: jendela milidetik, bukan kunci.
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { homedir } from 'node:os'
import npath from 'node:path'
import { fsFail, type FsFail, type FsResult } from '../shared/fsContract'
import { dataDir } from './config'
import { errnoOf, failFrom, logFsError } from './fsAtomic'
import { checkFsPath } from './fsOps'
import { discardTrash, lookupTrash, reserveTrash, sweepTrash, trashRoot } from './fsTrash'
import { createLogger } from './logs'

const log = createLogger('fs')

/** Direktori sistem yang tak boleh dihapus/dipindah/disalin (selain `/`, home dan leluhurnya, data dir). */
const PROTECTED_DIRS: readonly string[] = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/private', '/proc', '/root', '/sbin', '/sys', '/usr', '/var',
  '/System', '/Library', '/Applications', '/Users', '/home', '/Volumes',
]
/** Mode sementara direktori salinan: owner penuh supaya anak bisa ditulis walau sumber read-only. */
const COPY_DIR_TEMP_MODE = 0o700

let trashSwept = false

interface Loc { real: string; canon: string }

/** realpath induk + nama akhir; nama akhir (mungkin symlink/belum ada) tidak di-resolve. */
async function canonOf(p: string): Promise<string> {
  return npath.join(await fs.realpath(npath.dirname(p)), npath.basename(p))
}

/** True untuk `/`, direktori sistem, home + leluhurnya, data dir (DB) + leluhurnya, dan akar trash. $HOME didahulukan (os.homedir() di Bun ter-cache, tes tak bisa menggesernya). */
async function isProtected(canon: string): Promise<boolean> {
  if (canon === npath.parse(canon).root || PROTECTED_DIRS.includes(canon)) return true
  const data = await fs.realpath(dataDir())
  const keep = [await fs.realpath(process.env.HOME || homedir()), data, npath.join(data, npath.basename(trashRoot()))]
  return keep.some((k) => k === canon || k.startsWith(canon + npath.sep))
}

/** Validasi + kanonikkan satu path masukan; `FsFail` bila tak sah atau terlindungi. */
async function locate(path: string): Promise<Loc | FsFail> {
  const t = checkFsPath(path)
  if (typeof t !== 'string') return t
  const canon = await canonOf(t)
  if (await isProtected(canon)) return fsFail('EACCES', `${npath.basename(t)} is a protected path`)
  return { real: t, canon }
}

async function lstatOrNull(p: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(p, { bigint: true })
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return null
    throw err
  }
}

/** `to` berada DI DALAM `from` (bukan sama): memindah/menyalin folder ke dirinya sendiri. */
const isInside = (from: Loc, to: Loc): boolean => to.canon.startsWith(from.canon + npath.sep)

/** Salin rekursif ke `to` yang belum ada (EEXIST dari kernel, bukan cek-lalu-tulis). Symlink disalin sebagai link, tak diikuti. Gagal di tengah -> salinan yang kita buat dihapus. */
async function copyTree(from: string, to: string): Promise<void> {
  const st = await fs.lstat(from)
  if (st.isSymbolicLink()) return fs.symlink(await fs.readlink(from), to)
  if (st.isFile()) {
    try {
      await fs.copyFile(from, to, constants.COPYFILE_EXCL)
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') await fs.rm(to, { force: true }) // EEXIST = berkas milik orang lain, jangan disentuh
      throw err
    }
    return
  }
  if (!st.isDirectory()) throw Object.assign(new Error(`unsupported file type: ${npath.basename(from)}`), { code: 'EINVAL' })
  await fs.mkdir(to, { mode: COPY_DIR_TEMP_MODE })
  try {
    for (const name of await fs.readdir(from)) await copyTree(npath.join(from, name), npath.join(to, name))
    await fs.chmod(to, st.mode & 0o7777)
  } catch (err) {
    await fs.rm(to, { recursive: true, force: true }) // `to` baru kita buat di atas
    throw err
  }
}

/** Pindah `from` -> `to`; lintas-volume (EXDEV) = salin lalu hapus sumber. `rename` bisa disuntik (tes). */
export async function movePath(from: string, to: string, rename: (a: string, b: string) => Promise<void> = fs.rename): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if (errnoOf(err) !== 'EXDEV') throw err
    await copyTree(from, to)
    await fs.rm(from, { recursive: true })
  }
}

const done = (op: string, t: string): void => log.debug('fs.mutate', `fs ${op} ok`, { op, file: npath.basename(t) })

/** Hapus entri: default ke trash (balas `trashId`, bisa di-restore); `permanent` = `rm` rekursif. */
export async function deleteEntry(path: string, opts: { permanent?: boolean }): Promise<FsResult<{ trashId?: string }>> {
  const op = opts.permanent ? 'delete' : 'trash'
  try {
    const loc = await locate(path)
    if ('ok' in loc) return loc
    await fs.lstat(loc.real) // ENOENT sebelum slot trash dibuat
    if (opts.permanent) {
      await fs.rm(loc.real, { recursive: true })
      done(op, loc.real)
      return { ok: true }
    }
    if (!trashSwept) {
      trashSwept = true
      await sweepTrash() // retensi R-11; juga dipanggil start-up bila index.ts memanggil sweepTrash
    }
    const slot = await reserveTrash(loc.real)
    try {
      await movePath(loc.real, slot.dest)
    } catch (err) {
      // Salinan EXDEV yang lengkap + sumber setengah terhapus: simpan slot supaya data tak hilang.
      if ((await lstatOrNull(slot.dest)) === null) await discardTrash(slot.id)
      throw err
    }
    done(op, loc.real)
    return { ok: true, trashId: slot.id }
  } catch (err) {
    return failFrom(op, path, err)
  }
}

/** Kembalikan entri trash ke path asal; tujuan sudah ada -> `EEXIST` (tak menimpa), induk hilang -> `ENOENT`. */
export async function restoreEntry(trashId: string): Promise<FsResult<{ path: string }>> {
  try {
    const entry = await lookupTrash(trashId)
    if ('ok' in entry) return entry
    const dest = await locate(entry.origPath)
    if ('ok' in dest) return dest
    if (await lstatOrNull(dest.real)) return fsFail('EEXIST', `restore failed: ${npath.basename(dest.real)} already exists`)
    await movePath(entry.item, dest.real)
    done('restore', dest.real)
    await discardTrash(trashId).catch((err) => logFsError('restore-cleanup', trashId, err)) // sudah pulih; sisa trash disapu retensi
    return { ok: true, path: dest.real }
  } catch (err) {
    return failFrom('restore', trashId, err)
  }
}

/** Ganti nama/pindah. Tujuan ada -> `EEXIST` kecuali `overwrite` atau hanya beda huruf; folder ke dalam dirinya -> `EINVAL`. */
export async function renameEntry(from: string, to: string, opts: { overwrite?: boolean }): Promise<FsResult> {
  try {
    const a = await locate(from)
    if ('ok' in a) return a
    const b = await locate(to)
    if ('ok' in b) return b
    if (isInside(a, b)) return fsFail('EINVAL', `rename failed: cannot move ${npath.basename(a.real)} into itself`)
    const src = await fs.lstat(a.real, { bigint: true })
    const dst = await lstatOrNull(b.real)
    // Hanya-huruf (Foo -> foo) di FS case-insensitive: `to` ada tapi inode-nya milik `from` sendiri.
    const caseOnly = dst !== null && dst.ino === src.ino && dst.dev === src.dev && npath.dirname(a.canon) === npath.dirname(b.canon)
      && npath.basename(a.canon).toLowerCase() === npath.basename(b.canon).toLowerCase()
    if (dst && !opts.overwrite && !caseOnly) return fsFail('EEXIST', `rename failed: ${npath.basename(b.real)} already exists`)
    await fs.rename(a.real, b.real)
    done('rename', b.real)
    return { ok: true }
  } catch (err) {
    return failFrom('rename', to, err)
  }
}

/** Salin rekursif (symlink tak diikuti); tujuan ada -> `EEXIST`, folder ke dalam dirinya -> `EINVAL`. */
export async function copyEntry(from: string, to: string): Promise<FsResult> {
  try {
    const a = await locate(from)
    if ('ok' in a) return a
    const b = await locate(to)
    if ('ok' in b) return b
    if (isInside(a, b)) return fsFail('EINVAL', `copy failed: cannot copy ${npath.basename(a.real)} into itself`)
    await copyTree(a.real, b.real)
    done('copy', b.real)
    return { ok: true }
  } catch (err) {
    return failFrom('copy', to, err)
  }
}
