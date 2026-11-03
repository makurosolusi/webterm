// Penyimpanan trash file manager (WS-FM-04): `<WEBTERM_DATA_DIR>/trash/<id>/{<nama>,meta.json}`.
// Hanya buku-besar (alokasi, lookup, buang, sapu); pemindahan berkas ada di `fsOps.mutate.ts`.
// Semua `rm` di file ini mengarah ke `<trashRoot>/<id>` dengan id tervalidasi, tak pernah ke path pemanggil.
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { fsFail, type FsFail } from '../shared/fsContract'
import { dataDir } from './config'
import { errnoOf, logFsError } from './fsAtomic'

/** Nama folder trash di bawah data dir. */
const TRASH_DIR = 'trash'
const META_FILE = 'meta.json'
/** Entri trash yang lebih tua dari ini disapu saat start (R-11). */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ID_BYTES = 8
/** Bentuk id yang dibuat `reserveTrash`; apa pun selain ini ditolak sebelum menyentuh disk (traversal). */
const ID_RE = /^[0-9a-f]{16}$/

/** Isi `meta.json`: asal path dan waktu dibuang (epoch ms). */
export interface TrashMeta { origPath: string; deletedAt: number }
/** Entri trash yang ditemukan: folder id, lokasi berkas tersimpan, dan meta-nya. */
export interface TrashEntry extends TrashMeta { dir: string; item: string }

/** Akar trash. */
export function trashRoot(): string {
  return join(dataDir(), TRASH_DIR)
}

const metaPath = (dir: string): string => join(dir, META_FILE)

function parseMeta(raw: string): TrashMeta | null {
  const v: unknown = JSON.parse(raw)
  if (v === null || typeof v !== 'object') return null
  const m = v as Partial<TrashMeta>
  return typeof m.origPath === 'string' && typeof m.deletedAt === 'number' ? { origPath: m.origPath, deletedAt: m.deletedAt } : null
}

/** Siapkan slot trash baru: buat folder id, tulis meta, kembalikan `dest` tempat berkas harus dipindah. */
export async function reserveTrash(origPath: string): Promise<{ id: string; dest: string }> {
  const id = randomBytes(ID_BYTES).toString('hex')
  const dir = join(trashRoot(), id)
  await fs.mkdir(dir, { recursive: true })
  try {
    const meta: TrashMeta = { origPath, deletedAt: Date.now() }
    await fs.writeFile(metaPath(dir), JSON.stringify(meta), 'utf-8')
  } catch (err) {
    await discardTrash(id)
    throw err
  }
  return { id, dest: join(dir, basename(origPath)) }
}

/** Cari entri trash; id tak valid -> `EINVAL`, tak ada/meta rusak -> `ENOENT`. */
export async function lookupTrash(id: string): Promise<TrashEntry | FsFail> {
  if (!ID_RE.test(id)) return fsFail('EINVAL', 'invalid trash id')
  const dir = join(trashRoot(), id)
  let meta: TrashMeta | null
  try {
    meta = parseMeta(await fs.readFile(metaPath(dir), 'utf-8'))
  } catch (err) {
    logFsError('trash-lookup', dir, err)
    return fsFail('ENOENT', 'trash entry not found')
  }
  if (!meta) return fsFail('ENOENT', 'trash entry has no valid meta')
  return { ...meta, dir, item: join(dir, basename(meta.origPath)) }
}

/** Buang satu folder trash; id yang bukan hasil `reserveTrash` diabaikan, tak pernah dipakai sebagai path. */
export async function discardTrash(id: string): Promise<void> {
  if (ID_RE.test(id)) await fs.rm(join(trashRoot(), id), { recursive: true, force: true })
}

/** Usia entri: `deletedAt` dari meta; meta hilang/rusak -> mtime folder (sisa alokasi yang gagal). */
async function deletedAtOf(dir: string): Promise<number> {
  try {
    const meta = parseMeta(await fs.readFile(metaPath(dir), 'utf-8'))
    if (meta) return meta.deletedAt
  } catch (err) {
    logFsError('trash-sweep', dir, err)
  }
  return (await fs.stat(dir)).mtimeMs
}

/** Sapu entri trash lebih tua dari retensi; kembalikan jumlah yang dihapus. Tak pernah melempar. */
export async function sweepTrash(now = Date.now()): Promise<number> {
  const root = trashRoot()
  let ids: string[]
  try {
    ids = await fs.readdir(root)
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') logFsError('trash-sweep', root, err) // ENOENT = belum pernah ada trash
    return 0
  }
  let removed = 0
  for (const id of ids.filter((n) => ID_RE.test(n))) {
    try {
      if (now - (await deletedAtOf(join(root, id))) > TRASH_RETENTION_MS) {
        await discardTrash(id)
        removed++
      }
    } catch (err) {
      logFsError('trash-sweep', join(root, id), err)
    }
  }
  return removed
}
