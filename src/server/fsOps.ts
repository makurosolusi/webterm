// Operasi filesystem sisi server untuk node files (dan pembaca file mana pun yang lewat
// `/api/fs/*`). Operasi fs server + `expandHomePath` dari
// `fs-handlers.ts`; TIDAK diport: quick-open, sshFs, relay, tiket download.
//
// DUA KONTRAK YANG SENGAJA BERBEDA — JANGAN DISERAGAMKAN.
//
// 1. PENELUSURAN (`listDir`, `pathExists`) FAIL-OPEN: nilai kosong/false pada kegagalan. Client
//    BERGANTUNG pada itu: `classifyEmptyListing` (src/client/fileBrowse.ts) memutuskan arti listing
//    kosong dengan bertanya ke direktori INDUK, justru karena `list` tidak pernah throw.
//    (`listDirV2`/`statMeta` di bawah verb baru, boleh berkode galat.)
//
// 2. PEMBACAAN ISI (`readBinary`, `readTextMeta`) MELEMPAR. Untuk isi file, kosong adalah
//    jawaban yang SAH, jadi file tak-terbaca tak boleh tampak kosong: editor yang membuka buffer
//    kosong lalu Save akan MENIMPA file aslinya. Kegagalan harus sampai ke browser sebagai non-2xx
//    lewat `readErrorResult`. Sentinel too-large (`src/shared/fsLimits.ts`) BUKAN kegagalan.
//
// Tiap catch mengembalikan nilai yang didokumentasikan atau melempar dengan konteks, bukan `catch {}` kosong.
//
// KEAMANAN PATH — sengaja TIDAK ada jail: siapa pun
// yang bisa menjangkau endpoint ini sudah bisa men-spawn PTY lewat `/ws`. Yang NYATA menjaga ada di
// transport (loopback + Origin + token, `src/server/auth.ts`). Modul ini: `path.resolve` tiap input,
// batas ukuran `fsLimits.ts`, dan `checkFsPath` untuk verb v2. Isi file TIDAK PERNAH di-log.
import { constants as fsc, promises as fs, type BigIntStats, type Dirent, type Stats } from 'node:fs'
import { execFile } from 'node:child_process'
import { gitCommand } from './gitExec'
import { homedir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { FS_READ_BINARY_MAX_BYTES, FS_READ_MAX_BYTES, FILES_LIST_MAX_DEFAULT, tooLargeSentinel } from '../shared/fsLimits'
import { fsFail, type EntryKind, type FileMeta, type FsFail, type FsResult, type FsVersion, type ListV2, type ReadMeta } from '../shared/fsContract'
import { decodeStrict, sniffBinary } from '../shared/fileKind'
import { FS_NAME_MAX_BYTES, errnoOf, failFrom, logFsError, versionOf } from './fsAtomic'

const run = promisify(execFile)

/** Satu entry direktori di wire; kembarannya di `src/client/fileBrowse.ts` (client tak boleh menarik `node:fs`). */
export interface DirEntry {
  name: string
  dir: boolean
  /** Entry di-ignore oleh git — client meredamkan tampilannya. */
  ignored: boolean
}

/** Kembangkan `~` / `~/` terhadap home MESIN INI (client tak tahu home server). `~user` tetap literal. */
export function expandHomePath(p: string, home: string = homedir()): string {
  return p === '~' || p.startsWith('~/') ? npath.join(home, p.slice(1)) : p
}

/** Path absolut ternormalisasi untuk sebuah input; pintu masuk path modul ini (lihat catatan keamanan di atas). */
export function resolveFsPath(p: string, home: string = homedir()): string {
  return npath.resolve(expandHomePath(p, home))
}

/**
 * Di atas jumlah entry ini `git check-ignore` dilewati sama sekali: argv-nya memuat SETIAP nama,
 * jadi direktori patologis (node_modules yang di-flat, direktori cache) akan menabrak ARG_MAX dan
 * membuat panggilannya gagal total — bukan sebagian.
 * ponytail: ambang tetap; pindah ke `git check-ignore --stdin` bila ada direktori nyata yang
 * entry-nya kehilangan flag `ignored` karena ambang ini.
 */
const GIT_CHECK_IGNORE_MAX_ENTRIES = 2000

/** Tandai entry yang di-gitignore. SATU proses `git` untuk seluruh direktori (bukan satu per
 *  entry — itu N+1 proses). Memutasi `entries` di tempat; tidak pernah throw. */
async function flagIgnored(dir: string, entries: DirEntry[]): Promise<void> {
  if (entries.length === 0 || entries.length > GIT_CHECK_IGNORE_MAX_ENTRIES) return
  const flag = (out: string): void => {
    const set = new Set(
      out
        .split('\n')
        .map((s) => s.trim().replace(/\/$/, ''))
        .filter(Boolean)
    )
    for (const en of entries) if (set.has(en.name)) en.ignored = true
  }
  try {
    const g = gitCommand(['-C', dir, 'check-ignore', '--', ...entries.map((e) => e.name)])
    const { stdout } = await run(g.file, g.args, { maxBuffer: 4 * 1024 * 1024, env: g.env })
    flag(stdout)
  } catch (err) {
    // `check-ignore` keluar non-nol untuk "tidak ada yang cocok" (1) dan "bukan repo git" (128) —
    // keduanya normal, bukan kegagalan. Exit 1 TETAP mencetak nama yang cocok bila ada sebagian,
    // jadi stdout dibaca ulang alih-alih dibuang.
    const out = (err as { stdout?: string }).stdout
    if (out) flag(out)
  }
}

/**
 * Daftar isi direktori: folder dulu lalu file, masing-masing alfabetis; `.git` disembunyikan;
 * entry yang di-gitignore ditandai. `[]` pada kegagalan apa pun — lihat kontrak fail-open di
 * kepala file.
 */
export async function listDir(dirPath: string): Promise<DirEntry[]> {
  const dir = resolveFsPath(dirPath)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return [] // fail-open: client yang memutuskan arti listing kosong
  }
  const entries: DirEntry[] = dirents
    .filter((e) => e.name !== '.git')
    // Symlink ke direktori melaporkan `isDirectory() === false`; itu perilaku bawaan dan
    // `classifyEmptyListing` memang mencocokkan per NAMA, bukan per `dir`, demi kasus ini.
    .map((e) => ({ name: e.name, dir: e.isDirectory(), ignored: false }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  await flagIgnored(dir, entries)
  return entries
}

/** Kegagalan baca dengan konteks (operasi + path + penyebab asal). `Error` biasa, bukan subclass:
 *  satu-satunya hal yang perlu dibedakan pemanggil adalah errno, dan itu sudah ada di `cause`. */
function readFailed(op: string, target: string, err: unknown): Error {
  logFsError(op, target, err)
  return new Error(`fs ${op} failed: ${target}`, { cause: err })
}

/** errno yang bisa dibedakan dengan murah → status + pesan. Sisanya 500: menebak lebih buruk
 *  daripada mengaku tidak tahu. */
const READ_FAILURES = new Map<string, [number, string]>([
  ['ENOENT', [404, 'file not found']],
  ['ENOTDIR', [404, 'file not found']],
  ['EACCES', [403, 'permission denied']],
  ['EPERM', [403, 'permission denied']],
  ['EISDIR', [400, 'not a file']],
  ['EINVAL', [400, 'invalid path']],
  ['ENAMETOOLONG', [400, 'invalid path']],
])

/**
 * Status HTTP + body untuk Error dari `readBinary`/`readTextMeta`. Bentuknya sengaja cocok dengan
 * `FsApiResult` supaya route hanya perlu `.catch(readErrorResult)`.
 *
 * Pesannya generik dan tanpa path: body respons bukan tempat stack trace, isi file, atau detail
 * filesystem. Konteks lengkap ada di `Error.message` untuk diagnosis sisi server.
 */
export function readErrorResult(err: unknown): { status: number; body: { error: string } } {
  const [status, error] = READ_FAILURES.get(errnoOf(err)) ?? [500, 'cannot read file']
  return { status, body: { error } }
}

/** O_NONBLOCK: opening a FIFO with no writer returns at once instead of hanging (it is then refused). */
const READ_FLAGS = fsc.O_RDONLY | fsc.O_NONBLOCK

/** Regular-file guard + cap judged on the OPENED handle (sec-208-5): a path stat says size 0 for pipes
 *  and devices (`/dev/zero` read forever, a fed FIFO bypassed the cap) and left a swap window before
 *  open. `bytes` is null when the file is over `max`. */
async function readRegular(target: string, max: number): Promise<{ st: BigIntStats; bytes: Buffer | null }> {
  const fh = await fs.open(target, READ_FLAGS)
  try {
    const st = await fh.stat({ bigint: true })
    if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: st.isDirectory() ? 'EISDIR' : 'EINVAL' })
    if (st.size > BigInt(max)) return { st, bytes: null }
    const buf = Buffer.alloc(Number(st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return { st, bytes: buf.subarray(0, bytesRead) }
  } finally {
    await fh.close()
  }
}

/** Isi file sebagai base64 (preview gambar/biner). Sentinel di atas cap — cap-nya lebih besar tapi
 *  base64 masih menggelembungkan payload 1.33×. MELEMPAR bila file tidak terbaca / bukan file reguler. */
export async function readBinary(filePath: string): Promise<string> {
  const target = resolveFsPath(filePath)
  try {
    const { st, bytes } = await readRegular(target, FS_READ_BINARY_MAX_BYTES)
    return bytes === null ? tooLargeSentinel(Number(st.size)) : bytes.toString('base64')
  } catch (err) {
    throw readFailed('read-binary', target, err)
  }
}

/** True bila path ada (file maupun direktori). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(resolveFsPath(p))
    return true
  } catch {
    return false
  }
}

// ---- API v2 (file manager): hasil berkode `FsResult`; kegagalan TIDAK fail-open ----

/**
 * Validasi server atas path masuk (M-11/M-12): NUL ditolak, path non-absolut (setelah `~`) ->
 * `EINVAL` (bukan di-resolve terhadap cwd server), nama akhir >255 byte -> `ENAMETOOLONG`.
 * Mengembalikan path ternormalisasi, atau `FsFail`. Dipakai verb v2 saja; `list`/`exists` lama tak berubah.
 */
export function checkFsPath(p: string, home: string = homedir()): string | FsFail {
  if (p.includes('\0')) return fsFail('EINVAL', 'path contains NUL')
  if (!npath.isAbsolute(expandHomePath(p, home))) return fsFail('EINVAL', 'path must be absolute')
  const target = resolveFsPath(p, home)
  if (Buffer.byteLength(npath.basename(target)) > FS_NAME_MAX_BYTES) return fsFail('ENAMETOOLONG', 'name too long')
  return target
}

const STAT_CONCURRENCY = 64
const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Jalankan `fn` atas `items` dengan paling banyak `STAT_CONCURRENCY` sekaligus (cegah EMFILE). */
async function inBatches<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += STAT_CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + STAT_CONCURRENCY).map(fn))))
  return out
}

/** Entri awal dari dirent; symlink di-resolve ke target (dir? putus?), sisanya dari tipe dirent. */
async function metaOf(dir: string, d: Dirent): Promise<{ meta: FileMeta; st?: Stats }> {
  if (!d.isSymbolicLink()) {
    const kind: EntryKind = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
    return { meta: { name: d.name, dir: kind === 'dir', ignored: false, kind } }
  }
  try {
    const st = await fs.stat(npath.join(dir, d.name))
    const kind: EntryKind = st.isDirectory() ? 'symlink-dir' : 'symlink-file'
    return { meta: { name: d.name, dir: st.isDirectory(), ignored: false, kind, size: st.size, mtimeMs: st.mtimeMs }, st }
  } catch {
    // ENOENT/ELOOP = link putus: jawaban sah ('symlink-broken'), bukan kegagalan listing.
    return { meta: { name: d.name, dir: false, ignored: false, kind: 'symlink-broken' } }
  }
}

/**
 * list-v2: `FileMeta` (kind/size/mtimeMs, symlink di-resolve), natural-numeric, folder dulu, ber-cap
 * `limit` (`truncated`). Gagal baca direktori -> `FsFail` (beda dari `listDir` yang fail-open).
 */
export async function listDirV2(dirPath: string, limit = FILES_LIST_MAX_DEFAULT): Promise<FsResult<ListV2>> {
  const dir = checkFsPath(dirPath)
  if (typeof dir !== 'string') return dir
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return failFrom('list', dir, err)
  }
  const rows = await inBatches(dirents.filter((e) => e.name !== '.git'), (d) => metaOf(dir, d))
  rows.sort((a, b) => (a.meta.dir === b.meta.dir ? nameOrder.compare(a.meta.name, b.meta.name) || (a.meta.name < b.meta.name ? -1 : 1) : a.meta.dir ? -1 : 1))
  const kept = rows.slice(0, limit)
  // size/mtime hanya untuk yang lolos cap; symlink sudah punya dari stat target.
  await inBatches(kept.filter((r) => !r.st && r.meta.kind !== 'symlink-broken'), async (r) => {
    try {
      const st = await fs.lstat(npath.join(dir, r.meta.name))
      r.meta.size = st.size
      r.meta.mtimeMs = st.mtimeMs
    } catch (err) {
      logFsError('list-stat', r.meta.name, err) // entri hilang di antara readdir dan lstat: tampil tanpa size
    }
  })
  const entries = kept.map((r) => r.meta)
  await flagIgnored(dir, entries)
  return { ok: true, entries, truncated: rows.length > limit }
}

/**
 * Isi teks + metadata: versi (fstat handle SEBELUM baca, jadi salah-arahnya hanya konflik palsu, tak
 * pernah timpa diam-diam), encoding hasil sniff (`binary` = ada NUL, konten kosong; `non-utf8` =
 * byte tak sah, konten decode lossy untuk tampilan read-only). MELEMPAR (kontrak 2); sentinel
 * too-large tetap sukses.
 */
export async function readTextMeta(filePath: string): Promise<ReadMeta> {
  const target = checkFsPath(filePath)
  if (typeof target !== 'string') throw readFailed('read', filePath, Object.assign(new Error(target.error), { code: target.code }))
  try {
    const { st, bytes } = await readRegular(target, FS_READ_MAX_BYTES)
    const version = versionOf(st)
    if (bytes === null) return { content: tooLargeSentinel(Number(st.size)), version, encoding: 'utf8' }
    if (sniffBinary(bytes)) return { content: '', version, encoding: 'binary' }
    const text = decodeStrict(bytes)
    return text === null
      ? { content: new TextDecoder().decode(bytes), version, encoding: 'non-utf8' }
      : { content: text, version, encoding: 'utf8' }
  } catch (err) {
    throw readFailed('read', target, err)
  }
}

/** Metadata satu path (symlink diikuti; link putus -> `kind:'symlink-broken'`, version ''). Galat -> `FsFail`. */
export async function statMeta(p: string): Promise<FsResult<{ meta: FileMeta; version: FsVersion }>> {
  const target = checkFsPath(p)
  if (typeof target !== 'string') return target
  const name = npath.basename(target)
  try {
    const link = (await fs.lstat(target)).isSymbolicLink()
    try {
      const st = await fs.stat(target, { bigint: true })
      const kind: EntryKind = st.isDirectory() ? (link ? 'symlink-dir' : 'dir') : st.isFile() ? (link ? 'symlink-file' : 'file') : 'other'
      return { ok: true, version: versionOf(st), meta: { name, dir: st.isDirectory(), ignored: false, kind, size: Number(st.size), mtimeMs: Number(st.mtimeMs) } }
    } catch (err) {
      if (!link) throw err
      return { ok: true, version: '', meta: { name, dir: false, ignored: false, kind: 'symlink-broken' } }
    }
  } catch (err) {
    return failFrom('stat', target, err)
  }
}
