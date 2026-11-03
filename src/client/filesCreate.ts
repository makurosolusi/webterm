// Buat file/folder dari nama yang diketik di FilesInput. Dipisah dari FilesNode: ini urutan panggilan
// fsClient + pesan hasilnya (tanpa DOM), jadi bisa dites langsung dan menjaga shell di bawah batas ukuran.
import * as fsClient from './fsClient'
import { ancestorDirs, newEntryPath } from './fileBrowse'

/** Pesan saat nama sudah dipakai; juga dipakai FilesNode untuk hasil `created:false`. */
export const existsNotice = (name: string): string => `Sudah ada: ${name}`
/** Pesan validasi nama (juga ditampilkan live di FilesInput). */
export const NAME_NOT_ALLOWED = 'That name is not allowed here.'

export type CreateOutcome =
  | { ok: false; notice: string }
  | { ok: true; notice?: string; target: string; leaf: string; first: string }

/**
 * Buat `name` di dalam `base`. `create` eksklusif: nama yang sudah ada TIDAK ditimpa (G-01) dan
 * pesannya datang dari FsFail. Folder yang sudah ada tetap `ok` (daftar dimuat ulang) tapi bernotice.
 */
export async function createEntry(base: string, name: string, dir: boolean): Promise<CreateOutcome> {
  const target = newEntryPath(base, name)
  if (!target) return { ok: false, notice: NAME_NOT_ALLOWED }
  const clean = name.trim()
  const leaf = clean.split('/').pop() ?? clean
  const first = clean.split('/')[0]
  for (const p of ancestorDirs(base, name)) await fsClient.mkdir(p)
  if (dir) {
    const r = await fsClient.mkdirChecked(target)
    if (!r.ok) return { ok: false, notice: `Could not create ${name}: ${r.error}` }
    return { ok: true, target, leaf, first, notice: r.created ? undefined : existsNotice(leaf) }
  }
  const r = await fsClient.create(target)
  if (!r.ok) return { ok: false, notice: r.code === 'EEXIST' ? existsNotice(leaf) : `Could not create ${name}: ${r.error}` }
  return { ok: true, target, leaf, first }
}
