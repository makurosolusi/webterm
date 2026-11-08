// Operasi mutasi file manager di atas fsClient: SEKUENSIAL per item (satu kegagalan tidak membatalkan
// sisanya), tiap sukses meng-emit `fsEvents`, dan hasilnya dikembalikan sebagai laporan — tanpa DOM
// dan tanpa teks (kalimat ada di ./filesMessages, dirangkai alur di ./filesSlot.mutate).
// Nama entri = path RELATIF terhadap cwd ("src/a.ts"); `dir` = cwd absolut.
import type { FsFail, FsResult } from '../shared/fsContract'
import { childPath, parentDir } from './fileBrowse'
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
  /** Nama salinan yang terbentuk (relatif), searah dengan `done`. */
  created: string[]
}
/** One completed move/copy, absolute paths. */
export interface Moved { from: string; to: string }
export interface PasteReport extends Report { pairs: Moved[] }

/** Maksimum percobaan nama baru bila ada balapan EEXIST saat duplikat/tempel. */
const COPY_RETRIES = 5

/** Last segment of a path ("src/a.ts" -> "a.ts"). */
export const leafOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
/** Parent of a RELATIVE path ("src/a.ts" -> "src", "a.ts" -> ""). */
export const parentRel = (p: string): string => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
export const joinRel = (parent: string, leaf: string): string => (parent ? `${parent}/${leaf}` : leaf)
/** Leaf names of `rels` that live directly in folder `parent` (relative). */
export const leavesIn = (rels: readonly string[], parent: string): string[] =>
  rels.filter((r) => parentRel(r) === parent).map(leafOf)

/** Trash (default, carries `trashId`) or permanently delete absolute `paths`; `names` label the report. */
export async function removePaths(paths: readonly string[], names: readonly string[], permanent: boolean): Promise<DeleteReport> {
  const out: DeleteReport = { done: [], failed: [], trashed: [] }
  for (const [i, path] of paths.entries()) {
    const name = names[i]
    const r = await fsClient.remove(path, permanent)
    if (!r.ok) { out.failed.push({ name, fail: r }); continue }
    out.done.push(name)
    if (!permanent && r.trashId) out.trashed.push({ name, trashId: r.trashId })
    emitFsEvent({ kind: 'deleted', path, origin: 'local' })
  }
  return out
}

/** Hapus `names` di `dir` satu per satu: ke trash (default, membawa `trashId`) atau permanen. */
export const deleteMany = (dir: string, names: readonly string[], permanent: boolean): Promise<DeleteReport> =>
  removePaths(names.map((n) => childPath(dir, n)), names, permanent)

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

/**
 * Run `op` on `dstDir/<leaf>` (when `keep` and free) else on "<leaf> copy[ N]", retrying the next
 * free name on EEXIST (an item created by someone else since the listing). `taken` = names in dstDir.
 */
async function placeFree(dstDir: string, leaf: string, taken: Set<string>, keep: boolean, op: (dst: string) => Promise<FsResult>): Promise<{ to: string } | { fail: FsFail }> {
  let name = keep && !taken.has(leaf) ? leaf : copyName(leaf, taken)
  let fail: FsFail | null = null
  for (let i = 0; i < COPY_RETRIES; i++) {
    const to = childPath(dstDir, name)
    const r = await op(to)
    taken.add(name)
    if (r.ok) return { to }
    fail = r
    if (r.code !== 'EEXIST') break
    name = copyName(leaf, taken)
  }
  return { fail: fail as FsFail }
}

/** Duplikat tiap `names` ke "<nama> copy[ N]" di foldernya; `existing` = baris terlihat (relatif). */
export async function duplicateMany(dir: string, names: readonly string[], existing: readonly string[]): Promise<DuplicateReport> {
  const out: DuplicateReport = { done: [], failed: [], created: [] }
  const taken = new Map<string, Set<string>>()
  for (const name of names) {
    const parent = parentRel(name)
    if (!taken.has(parent)) taken.set(parent, new Set(leavesIn(existing, parent)))
    const src = childPath(dir, name)
    const r = await placeFree(parentDir(src), leafOf(name), taken.get(parent)!, false, (to) => fsClient.copy(src, to))
    if ('fail' in r) { out.failed.push({ name, fail: r.fail }); continue }
    out.done.push(name)
    out.created.push(joinRel(parent, leafOf(r.to)))
    emitFsEvent({ kind: 'created', path: r.to, origin: 'local' })
  }
  return out
}

/**
 * Paste absolute `srcs` into `dstDir`: copy, or move (rename) when `move`. A name already in `taken`
 * becomes "name copy[ N]"; moving an item onto its own folder is a no-op (not reported).
 */
export async function pasteMany(srcs: readonly string[], dstDir: string, move: boolean, taken: readonly string[]): Promise<PasteReport> {
  const out: PasteReport = { done: [], failed: [], pairs: [] }
  const used = new Set(taken)
  for (const from of srcs) {
    const name = leafOf(from)
    if (move && parentDir(from) === dstDir.replace(/\/+$/, '')) continue
    const r = await placeFree(dstDir, name, used, true, (to) => (move ? fsClient.rename(from, to, false) : fsClient.copy(from, to)))
    if ('fail' in r) { out.failed.push({ name, fail: r.fail }); continue }
    out.done.push(name)
    out.pairs.push({ from, to: r.to })
    emitFsEvent(move ? { kind: 'renamed', path: r.to, from, origin: 'local' } : { kind: 'created', path: r.to, origin: 'local' })
  }
  return out
}

/** Move absolute `from` -> `to` without overwriting (`EEXIST` when `to` exists). */
export async function moveOne(from: string, to: string): Promise<Report> {
  const r = await fsClient.rename(from, to, false)
  if (!r.ok) return { done: [], failed: [{ name: leafOf(from), fail: r }] }
  emitFsEvent({ kind: 'renamed', path: to, from, origin: 'local' })
  return { done: [leafOf(from)], failed: [] }
}

/** Ganti nama `from` (relatif) menjadi segmen `to` di folder yang sama, tanpa menimpa. */
export async function renameOne(dir: string, from: string, to: string): Promise<Report> {
  const r = await moveOne(childPath(dir, from), childPath(dir, joinRel(parentRel(from), to)))
  return r.done.length ? { done: [from], failed: [] } : { done: [], failed: r.failed.map((f) => ({ ...f, name: from })) }
}
