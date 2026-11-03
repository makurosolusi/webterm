// Slot mutate (WS-FM-05): Rename (F2, inline), Delete (konfirmasi -> trash -> toast Undo), Shift+Delete
// (konfirmasi permanen) dan Duplicate. Aktif hanya bila `capabilities().mutate`; selain itu tidak
// menambah menu, tombol, atau overlay apa pun. "New File/Folder" tetap di menu bawaan shell, yang
// memakai `ctx.startInput` yang sama.
import { useEffect, useState, type KeyboardEvent } from 'react'
import FilesMutateOverlay from './FilesMutateOverlay'
import { codicon } from './FilesMenu'
import { checkName } from './filesName'
import { failText, KEYS, MENU, nameProblemText, TOAST, type MutateAction } from './filesMessages'
import { deleteMany, duplicateMany, renameOne, restoreMany, type Failure, type TrashedItem } from './filesMutate'
import { clearUi, pushToast, setConfirm, type Toast } from './filesMutate.store'
import type { FilesSlot, FilesSlotCtx, SlotMenuRow } from './filesSlots'
import { capabilities } from './fsClient'

/** Node yang slot-nya aktif (cap mutate terbukti hidup); satu-satunya penjaga menu/tombol/toast. */
const enabled = new Set<string>()
/** Jumlah kegagalan yang dirinci di toast (sisanya diringkas jumlahnya). */
const MAX_LISTED = 3

/** Ambil dari ctx hanya yang dibutuhkan alur async (ctx dibuat ulang tiap render). */
interface Scope { nodeId: string; dir: string; existing: string[]; refresh: (select?: string) => void }
const scopeOf = (c: FilesSlotCtx): Scope => ({ nodeId: c.nodeId, dir: c.dir, existing: c.entries.map((e) => e.name), refresh: c.refresh })

function toast(s: Scope, t: Omit<Toast, 'id'>): void {
  if (enabled.has(s.nodeId)) pushToast(s.nodeId, t)
}

/** Toast galat sticky: satu kegagalan = kalimat lengkap; banyak = ringkasan + beberapa alasan pertama. */
function reportFailures(s: Scope, action: MutateAction, failed: Failure[], total: number): void {
  if (failed.length === 0) return
  const texts = failed.slice(0, MAX_LISTED).map((f) => failText(action, f.name, f.fail))
  if (total === 1) { toast(s, { severity: 'error', title: texts[0] }); return }
  const more = failed.length > MAX_LISTED ? ` (+${failed.length - MAX_LISTED} lainnya)` : ''
  toast(s, { severity: 'error', title: TOAST.failedSome(failed.length, total), message: texts.join(' ') + more })
}

async function undoDelete(s: Scope, items: TrashedItem[]): Promise<void> {
  const r = await restoreMany(items)
  s.refresh(r.paths[0]?.split('/').pop())
  if (r.done.length) toast(s, { severity: 'info', title: TOAST.restored(r.done.length, r.done[0]) })
  reportFailures(s, 'restore', r.failed, items.length)
}

async function runDelete(s: Scope, names: string[], permanent: boolean): Promise<void> {
  const r = await deleteMany(s.dir, names, permanent)
  s.refresh()
  if (r.done.length) {
    const title = permanent ? TOAST.deleted(r.done.length, r.done[0]) : TOAST.trashed(r.done.length, r.done[0])
    const actions = r.trashed.length ? [{ label: TOAST.undo, onClick: () => { void undoDelete(s, r.trashed) } }] : undefined
    toast(s, { severity: 'info', title, actions })
  }
  reportFailures(s, 'delete', r.failed, names.length)
}

async function runDuplicate(s: Scope, names: string[]): Promise<void> {
  const r = await duplicateMany(s.dir, names, s.existing)
  s.refresh(r.created[0])
  // Satu salinan terlihat langsung di daftar; ringkasan hanya berarti untuk kelompok.
  if (names.length > 1 && r.done.length) toast(s, { severity: 'info', title: TOAST.duplicated(r.done.length, r.done[0]) })
  reportFailures(s, 'duplicate', r.failed, names.length)
}

async function commitRename(s: Scope, from: string, raw: string): Promise<void> {
  const c = checkName(raw)
  if (!c.ok) { toast(s, { severity: 'error', title: nameProblemText(c.problem) }); return }
  if (c.name === from) return
  const r = await renameOne(s.dir, from, c.name)
  if (r.done.length) s.refresh(c.name)
  for (const f of r.failed) toast(s, { severity: 'error', title: failText('rename', f.name, f.fail, c.name) })
}

function askDelete(c: FilesSlotCtx, permanent: boolean): void {
  const s = scopeOf(c)
  const names = c.selection
  setConfirm(c.nodeId, { names, permanent, dir: c.dir, onConfirm: () => { void runDelete(s, names, permanent) } })
}

function startRename(c: FilesSlotCtx): void {
  const [from] = c.selection
  const s = scopeOf(c)
  c.startInput({ kind: 'rename', initial: from, onCommit: (name) => commitRename(s, from, name) })
}

const row = (label: string, icon: string, keybinding: string | undefined, onClick: () => void, danger = false): SlotMenuRow =>
  ({ label, icon: codicon(icon), keybinding, onClick, danger })

function menu(c: FilesSlotCtx): SlotMenuRow[] {
  if (!enabled.has(c.nodeId) || c.selection.length === 0) return []
  return [
    ...(c.selection.length === 1 ? [row(MENU.rename, 'edit', KEYS.rename, () => startRename(c))] : []),
    row(MENU.duplicate, 'files', undefined, () => { void runDuplicate(scopeOf(c), c.selection) }),
    { type: 'separator' },
    row(MENU.trash, 'trash', KEYS.trash, () => askDelete(c, false)),
    row(MENU.permanent, 'close-all', KEYS.permanent, () => askDelete(c, true), true),
  ]
}

function onKey(e: KeyboardEvent, c: FilesSlotCtx): boolean {
  if (!enabled.has(c.nodeId) || e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.key === 'F2' && !e.shiftKey && c.selection.length === 1) { startRename(c); return true }
  if (e.key === 'Delete' && c.selection.length > 0) { askDelete(c, e.shiftKey); return true }
  return false
}

/** Hook per-node: tanya kemampuan server (fail-closed), daftarkan node aktif, bersihkan saat lepas. */
function useSlot(c: FilesSlotCtx): void {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    void capabilities().then((caps) => { if (live) setOn(caps.mutate) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (on) enabled.add(c.nodeId)
    return () => { enabled.delete(c.nodeId); clearUi(c.nodeId) }
  }, [on, c.nodeId])
  // Konfirmasi adalah pertanyaan tentang satu folder; pindah folder membatalkannya.
  useEffect(() => { setConfirm(c.nodeId, null) }, [c.cwd, c.nodeId])
}

export const mutateSlot: FilesSlot = {
  id: 'mutate',
  menu,
  onKey,
  useSlot,
  overlay: (c) => <FilesMutateOverlay nodeId={c.nodeId} />,
}
