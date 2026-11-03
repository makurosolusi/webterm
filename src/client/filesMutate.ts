// Operasi mutasi file manager di atas fsClient: SEKUENSIAL per item (satu kegagalan tidak membatalkan
// sisanya), tiap sukses meng-emit `fsEvents`, dan hasilnya dikembalikan sebagai laporan — tanpa DOM
// dan tanpa teks (kalimat ada di ./filesMessages, dirangkai alur di ./filesSlot.mutate).
import type { FsFail } from '../shared/fsContract'
import { childPath } from './fileBrowse'
import { emitFsEvent } from './fsEvents'
import * as fsClient from './fsClient'
import { copyName } from './filesName'

export interface Failure { name: string; fail: FsFail }
export interface Report {
  /** Nama sumber yang berhasil. */
  done: string[]
  failed: Failure[]
}
export interface TrashedItem { name: string; trashId: string }
export interface DeleteReport extends Report { trashed: TrashedItem[] }
export interface DuplicateReport extends Report {
  /** Nama salinan yang terbentuk, searah dengan `done`. */
  created: string[]
}

/** Maksimum percobaan nama baru bila ada balapan EEXIST saat duplikat. */
const COPY_RETRIES = 5

/** Hapus `names` di `dir` satu per satu: ke trash (default, membawa `trashId`) atau permanen. */
export async function deleteMany(dir: string, names: readonly string[], permanent: boolean): Promise<DeleteReport> {
  const out: DeleteReport = { done: [], failed: [], trashed: [] }
  for (const name of names) {
    const path = childPath(dir, name)
    const r = await fsClient.remove(path, permanent)
    if (!r.ok) { out.failed.push({ name, fail: r }); continue }
    out.done.push(name)
    if (!permanent && r.trashId) out.trashed.push({ name, trashId: r.trashId })
    emitFsEvent({ kind: 'deleted', path, origin: 'local' })
  }
  return out
}

/** Pulihkan item dari trash ke tempat asal (server menolak menimpa: `EEXIST`). */
export async function restoreMany(items: readonly TrashedItem[]): Promise<Report & { paths: string[] }> {
  const out: Report & { paths: string[] } = { done: [], failed: [], paths: [] }
  for (const it of items) {
    const r = await fsClient.restore(it.trashId)
    if (!r.ok) { out.failed.push({ name: it.name, fail: r }); continue }
    out.done.push(it.name)
    out.paths.push(r.path)
    emitFsEvent({ kind: 'created', path: r.path, origin: 'local' })
  }
  return out
}

/** Duplikat tiap `names` ke "<nama> copy[ N]"; `existing` = isi folder agar nama baru tak bentrok. */
export async function duplicateMany(dir: string, names: readonly string[], existing: readonly string[]): Promise<DuplicateReport> {
  const out: DuplicateReport = { done: [], failed: [], created: [] }
  const taken = new Set(existing)
  for (const name of names) {
    let last: FsFail | null = null
    for (let i = 0; i < COPY_RETRIES; i++) {
      const target = copyName(name, taken)
      const r = await fsClient.copy(childPath(dir, name), childPath(dir, target))
      taken.add(target)
      if (r.ok) {
        out.done.push(name)
        out.created.push(target)
        emitFsEvent({ kind: 'created', path: childPath(dir, target), origin: 'local' })
        last = null
        break
      }
      last = r
      // Hanya bentrok nama (dibuat pihak lain sejak listing) yang layak dicoba lagi dengan nama berikutnya.
      if (r.code !== 'EEXIST') break
    }
    if (last) out.failed.push({ name, fail: last })
  }
  return out
}

/** Ganti nama `from` -> `to` di `dir` tanpa menimpa (`EEXIST` bila `to` ada). */
export async function renameOne(dir: string, from: string, to: string): Promise<Report> {
  const [src, dst] = [childPath(dir, from), childPath(dir, to)]
  const r = await fsClient.rename(src, dst, false)
  if (!r.ok) return { done: [], failed: [{ name: from, fail: r }] }
  emitFsEvent({ kind: 'renamed', path: dst, from: src, origin: 'local' })
  return { done: [from], failed: [] }
}
