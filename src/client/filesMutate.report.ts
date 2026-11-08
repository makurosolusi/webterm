// Shared by the mutate slot's flows (filesSlot.mutate / .clipboard, filesUndo): which nodes are live,
// the per-flow scope snapshot and toast reporting of results/failures.
import { displayNames, failText, TOAST, type MutateAction } from './filesMessages'
import { pushToast, type Toast } from './filesMutate.store'
import type { Failure } from './filesMutate'
import { revert, takeUndo, type UndoEntry } from './filesUndo'
import type { FilesSlotCtx } from './filesSlots'
import { offerFilesWrite, WRITE_OFFER_TEXT } from './filesWriteOffer'

/** Node yang slot-nya aktif (cap mutate terbukti hidup); satu-satunya penjaga menu/tombol/toast. */
export const enabled = new Set<string>()
/** Node yang servernya terbukti menjawab mutate mati: menu menampilkan baris terkunci. */
export const locked = new Set<string>()
/** Jumlah kegagalan yang dirinci di toast (sisanya diringkas jumlahnya). */
const MAX_LISTED = 3

/** Ambil dari ctx hanya yang dibutuhkan alur async (ctx dibuat ulang tiap render). */
export interface Scope { nodeId: string; dir: string; existing: string[]; refresh: (select?: string) => void }
export const scopeOf = (c: FilesSlotCtx): Scope => ({ nodeId: c.nodeId, dir: c.dir, existing: c.entries.map((e) => e.name), refresh: c.refresh })

export function toast(s: Scope, t: Omit<Toast, 'id'>): void {
  if (enabled.has(s.nodeId)) pushToast(s.nodeId, t)
}

/** Galat EDISABLED (kemampuan dimatikan setelah slot aktif) membawa aksi yang membuka tawaran. */
export const enableActions = (s: Scope, failed: Failure[]): Toast['actions'] =>
  failed.some((f) => f.fail.code === 'EDISABLED') ? [{ label: WRITE_OFFER_TEXT.enableAction, onClick: () => offerFilesWrite(s.nodeId) }] : undefined

/** Toast galat sticky: satu kegagalan = kalimat lengkap; banyak = ringkasan + beberapa alasan pertama. */
export function reportFailures(s: Scope, action: MutateAction, failed: Failure[], total: number, subject?: string): void {
  if (failed.length === 0) return
  const shown = displayNames(failed.map((f) => f.name))
  const texts = failed.slice(0, MAX_LISTED).map((f, i) => failText(action, shown[i], f.fail, subject ?? shown[i]))
  const actions = enableActions(s, failed)
  if (total === 1) { toast(s, { severity: 'error', title: texts[0], actions }); return }
  const more = failed.length > MAX_LISTED ? ` (+${failed.length - MAX_LISTED} more)` : ''
  toast(s, { severity: 'error', title: TOAST.failedSome(failed.length, total), message: texts.join(' ') + more, actions })
}

/** Revert `e` and report it; `fromToast` = the toast's own Undo (no-op when Cmd+Z already did it). */
export async function runUndo(s: Scope, e: UndoEntry, fromToast = false): Promise<void> {
  if (fromToast && !takeUndo(s.nodeId, e)) return
  const r = await revert(e)
  s.refresh(r.paths[0] ? relTo(s.dir, r.paths[0]) : undefined)
  if (r.done.length) {
    const title = e.kind === 'trash' ? TOAST.restored(r.done.length, r.done[0]) : TOAST.undone(r.done.length, r.done[0])
    toast(s, { severity: 'info', title })
  }
  reportFailures(s, e.kind === 'trash' ? 'restore' : 'undo', r.failed, r.done.length + r.failed.length)
}

/** Absolute `path` relative to `dir`, or undefined when it lies outside. */
export function relTo(dir: string, path: string): string | undefined {
  const root = dir.replace(/\/+$/, '') + '/'
  return path.startsWith(root) ? path.slice(root.length) : undefined
}

/** Toast Undo action for a freshly pushed undo entry. */
export const undoAction = (s: Scope, e: UndoEntry): Toast['actions'] =>
  [{ label: TOAST.undo, onClick: () => { void runUndo(s, e, true) } }]
