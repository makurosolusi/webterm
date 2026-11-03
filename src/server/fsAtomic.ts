// Primitif tulis aman untuk file manager (WS-FM-01): versi file, pemetaan errno -> FsErrCode, tulis
// atomik (temp + fsync + rename) dan penyapu sisa temp. Hanya primitif; keputusan (cek versi,
// fallback in-place) ada di `fsOps.write.ts`.
//
// Temp bernama `.webterm-<rand>.tmp` di direktori yang SAMA dengan target (rename atomik hanya
// dalam satu volume). Tanpa nama target di dalamnya: tak ada batas 255 byte yang bisa terlewati,
// dan cocok dengan filter watcher `.webterm-*.tmp` (WS-FM-07).
import { randomBytes } from 'node:crypto'
import { promises as fs, type BigIntStats } from 'node:fs'
import npath from 'node:path'
import { fsErrCode, fsFail, type FsErrCode, type FsFail, type FsVersion } from '../shared/fsContract'
import { createLogger } from './logs'

const log = createLogger('fs')

/** Batas panjang satu nama entri (byte) di kebanyakan filesystem. */
export const FS_NAME_MAX_BYTES = 255
const TMP_PREFIX = '.webterm-'
const TMP_SUFFIX = '.tmp'
const TMP_RE = /^\.webterm-[\w-]+\.tmp$/
/** Temp yang lebih tua dari ini dianggap sisa tulis yang mati dan boleh disapu. */
export const STALE_TMP_MS = 60 * 60 * 1000
/** Satu direktori disapu paling sering sekali per jeda ini (readdir direktori besar tidak murah). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const lastSweep = new Map<string, number>() // ponytail: tumbuh sebesar jumlah direktori yang pernah ditulis; cukup untuk sesi biasa

/** Versi opaque `${mtimeNs}-${size}` dari stat bigint (float `mtimeMs` kehilangan presisi). */
export function versionOf(st: BigIntStats): FsVersion {
  return `${st.mtimeNs}-${st.size}`
}

/** errno di balik sebuah galat; membuka `cause` bila galat dibungkus (`readFailed`). */
export function errnoOf(err: unknown): string {
  const origin = err instanceof Error && err.cause !== undefined ? err.cause : err
  return origin !== null && typeof origin === 'object' && 'code' in origin ? String(origin.code) : ''
}

/** `fs.error` (warn): operasi, basename, errno. Basename saja — path penuh memuat nama pengguna. */
export function logFsError(op: string, target: string, err: unknown): void {
  log.warn('fs.error', `fs ${op} failed`, { op, file: npath.basename(target), code: errnoOf(err) || undefined })
}

/** errno -> kode kontrak; EPERM (operasi ditolak) dilaporkan sebagai EACCES, yang tak dikenal EIO. */
export function codeOf(err: unknown): FsErrCode {
  const n = errnoOf(err)
  return fsErrCode(n === 'EPERM' ? 'EACCES' : n)
}

/** Galat fs -> `FsFail` bercontext (operasi + basename + errno), dicatat `fs.error` (warn; dipegang `systemLogEvents.test.ts`). */
export function failFrom(op: string, target: string, err: unknown): FsFail {
  logFsError(op, target, err)
  const code = codeOf(err)
  return fsFail(code, `${op} failed: ${npath.basename(target)} (${code})`)
}

/** Tulis `content` ke `real` lewat temp + fsync + rename. `st` = stat file lama (mode dipertahankan). */
export async function writeAtomic(real: string, content: string, st: BigIntStats | null): Promise<void> {
  const tmp = npath.join(npath.dirname(real), `${TMP_PREFIX}${randomBytes(6).toString('hex')}${TMP_SUFFIX}`)
  const mode = st ? Number(st.mode & 0o7777n) : 0o666
  try {
    const fh = await fs.open(tmp, 'wx', mode)
    try {
      await fh.writeFile(content, 'utf-8')
      if (st) await fh.chmod(mode) // umask mempersempit mode saat open; kembalikan mode asli
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, real)
  } catch (err) {
    await fs.rm(tmp, { force: true }) // jangan tinggalkan temp bila tulis/rename gagal (mis. ENOSPC)
    throw err
  }
}

/** True bila rename atas file ini tak merusak apa pun: reguler, tanpa hardlink lain, pemilik sama. */
export function canReplaceAtomically(st: BigIntStats): boolean {
  const uid = process.getuid?.()
  return st.isFile() && st.nlink === 1n && (uid === undefined || st.uid === BigInt(uid))
}

/** Hapus `.webterm-*.tmp` basi di `dir`. Dibatasi sekali per `SWEEP_INTERVAL_MS`; tak pernah melempar. */
export async function sweepStaleTmp(dir: string, now = Date.now()): Promise<void> {
  if (now - (lastSweep.get(dir) ?? 0) < SWEEP_INTERVAL_MS) return
  lastSweep.set(dir, now)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    logFsError('sweep', dir, err)
    return
  }
  for (const name of names.filter((n) => TMP_RE.test(n))) {
    const p = npath.join(dir, name)
    const st = await fs.stat(p).catch(() => null) // null = hilang bersamaan (ditulis/selesai oleh proses lain)
    if (st && now - st.mtimeMs > STALE_TMP_MS) await fs.rm(p, { force: true }).catch((err) => logFsError('sweep', p, err))
  }
}
