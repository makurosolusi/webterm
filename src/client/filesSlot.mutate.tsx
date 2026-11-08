// Slot mutate (WS-FM-05): Rename (F2 / double-click, inline on the row), Delete (konfirmasi -> trash ->
// toast Undo), permanent delete, Duplicate, clipboard Cut/Copy/Paste (filesSlot.clipboard) and Undo
// (filesUndo). Aktif hanya bila `capabilities().mutate`; bila server menjawab mati, Rename/Delete tetap
// tampil terkunci (gembok + alasan) dan membuka tawaran filesWrite (filesWriteOffer.tsx).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import FilesMutateOverlay from './FilesMutateOverlay'
import { codicon } from './FilesMenu'
import { childPath } from './fileBrowse'
import { checkName } from './filesName'
import { failText, KEYS, MENU, nameProblemText, TOAST } from './filesMessages'
import { deleteMany, duplicateMany, joinRel, leafOf, parentRel, renameOne } from './filesMutate'
import { enableActions, enabled, locked, reportFailures, runUndo, scopeOf, toast, undoAction, type Scope } from './filesMutate.report'
import { clearUi, setConfirm } from './filesMutate.store'
import { clearClip, decorateCut, getClip, paste, putClip, useClip } from './filesSlot.clipboard'
import { clearUndo, popUndo, pushUndo, type UndoEntry } from './filesUndo'
import type { FilesSlot, FilesSlotCtx, SlotMenuRow } from './filesSlots'
import { FilesWriteOffer, lockedRow, useFilesWriteEpoch } from './filesWriteOffer'
import { capabilities } from './fsClient'
import { onFsEvent } from './fsEvents'

async function runDelete(s: Scope, names: string[], permanent: boolean): Promise<void> {
  const r = await deleteMany(s.dir, names, permanent)
  s.refresh()
  if (r.done.length) {
    const title = permanent ? TOAST.deleted(r.done.length, r.done[0]) : TOAST.trashed(r.done.length, r.done[0])
    let actions
    if (r.trashed.length) {
      const e: UndoEntry = { kind: 'trash', items: r.trashed }
      pushUndo(s.nodeId, e)
      actions = undoAction(s, e)
    }
    toast(s, { severity: 'info', title, actions })
  }
  reportFailures(s, 'delete', r.failed, names.length)
}

async function runDuplicate(s: Scope, names: string[]): Promise<void> {
  const r = await duplicateMany(s.dir, names, s.existing)
  s.refresh(r.created[0])
  if (r.created.length) pushUndo(s.nodeId, { kind: 'copy', paths: r.created.map((rel) => childPath(s.dir, rel)) })
  // Satu salinan terlihat langsung di daftar; ringkasan hanya berarti untuk kelompok.
  if (names.length > 1 && r.done.length) toast(s, { severity: 'info', title: TOAST.duplicated(r.done.length, r.done[0]) })
  reportFailures(s, 'duplicate', r.failed, names.length)
}

async function commitRename(s: Scope, from: string, raw: string): Promise<void> {
  const c = checkName(raw)
  if (!c.ok) { toast(s, { severity: 'error', title: nameProblemText(c.problem) }); return }
  if (c.name === leafOf(from)) return
  const r = await renameOne(s.dir, from, c.name)
  const to = joinRel(parentRel(from), c.name)
  if (r.done.length) {
    pushUndo(s.nodeId, { kind: 'move', pairs: [{ from: childPath(s.dir, from), to: childPath(s.dir, to) }] })
    s.refresh(to)
  }
  for (const f of r.failed) toast(s, { severity: 'error', title: failText('rename', leafOf(f.name), f.fail, c.name), actions: enableActions(s, [f]) })
}

function askDelete(c: FilesSlotCtx, permanent: boolean): void {
  const s = scopeOf(c)
  const names = c.selection
  setConfirm(c.nodeId, { names, permanent, dir: c.dir, onConfirm: () => { void runDelete(s, names, permanent) } })
}

/** Open the inline rename input on row `rel` (F2, menu, double-click via `ctx.startRenameAt`). */
export function renameAt(c: FilesSlotCtx, rel: string): void {
  if (!enabled.has(c.nodeId)) return
  const s = scopeOf(c)
  c.startInput({ kind: 'rename', initial: leafOf(rel), at: rel, onCommit: (name) => commitRename(s, rel, name) })
}

/** Cmd+Z: revert this node's latest change; false (key released) when there is nothing to undo. */
function undoLast(c: FilesSlotCtx): boolean {
  const e = popUndo(c.nodeId)
  if (e) void runUndo(scopeOf(c), e)
  return !!e
}

const row = (label: string, icon: string, keybinding: string | undefined, onClick: () => void, danger = false): SlotMenuRow =>
  ({ label, icon: codicon(icon), keybinding, onClick, danger })

function menu(c: FilesSlotCtx): SlotMenuRow[] {
  const one = c.selection.length === 1
  if (locked.has(c.nodeId) && c.selection.length) {
    return [...(one ? [lockedRow(c.nodeId, MENU.rename, KEYS.rename)] : []), lockedRow(c.nodeId, MENU.trash, KEYS.trash)]
  }
  if (!enabled.has(c.nodeId)) return []
  const pasteRow = getClip() ? [row(MENU.paste, 'clippy', KEYS.paste, () => { void paste(c) })] : []
  if (c.selection.length === 0) return pasteRow
  return [
    row(MENU.cut, 'diff-removed', KEYS.cut, () => putClip(c, 'cut')),
    row(MENU.copy, 'copy', KEYS.copy, () => putClip(c, 'copy')),
    ...pasteRow,
    { type: 'separator' },
    ...(one ? [row(MENU.rename, 'edit', KEYS.rename, () => renameAt(c, c.selection[0]))] : []),
    row(MENU.duplicate, 'files', undefined, () => { void runDuplicate(scopeOf(c), c.selection) }),
    { type: 'separator' },
    row(MENU.trash, 'trash', KEYS.trash, () => askDelete(c, false)),
    row(MENU.permanent, 'close-all', KEYS.permanent, () => askDelete(c, true), true),
  ]
}

function onKey(e: KeyboardEvent, c: FilesSlotCtx): boolean {
  if (!enabled.has(c.nodeId)) return false
  const has = c.selection.length > 0
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
    // ⌘⌫ = trash, ⌥⌘⌫ = permanent (both confirm), as in VS Code on macOS.
    if (e.key === 'Backspace') { if (has) askDelete(c, e.altKey); return has }
    if (e.altKey) return false
    switch (e.key.toLowerCase()) {
      case 'c': if (has) putClip(c, 'copy'); return has
      case 'x': if (has) putClip(c, 'cut'); return has
      case 'v': if (getClip()) void paste(c); return !!getClip()
      case 'z': return undoLast(c)
      default: return false
    }
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.key === 'Escape' && getClip()?.mode === 'cut') { clearClip(); return true }
  if (e.key === 'F2' && !e.shiftKey && c.selection.length === 1) { renameAt(c, c.selection[0]); return true }
  if (e.key === 'Delete' && has) { askDelete(c, e.shiftKey); return true }
  return false
}

/**
 * A paste, drop, delete or undo in ANOTHER Files node (or this one) that touches this node's tree
 * reloads it; one reload per tick however many items moved. The watch slot covers outside changes.
 * ponytail: the acting node reloads twice (its own refresh + this); tag events with a node id if that shows.
 */
function useReloadOnLocalChange(c: FilesSlotCtx): void {
  const refresh = useRef(c.refresh)
  refresh.current = c.refresh
  useEffect(() => {
    const root = c.dir.replace(/\/+$/, '')
    const inTree = (p?: string) => !!p && p.startsWith(`${root}/`)
    let queued = false
    return onFsEvent((e) => {
      if (e.origin !== 'local' || e.kind === 'dirty' || e.kind === 'written' || !(inTree(e.path) || inTree(e.from)) || queued) return
      queued = true
      queueMicrotask(() => { queued = false; refresh.current() })
    })
  }, [c.dir])
}

/** Hook per-node: tanya kemampuan server (fail-closed), daftarkan node aktif, bersihkan saat lepas. */
function useSlot(c: FilesSlotCtx): void {
  // null = belum terjawab (fail-closed: tanpa menu sama sekali, juga tanpa baris terkunci).
  const [on, setOn] = useState<boolean | null>(null)
  const epoch = useFilesWriteEpoch()
  useClip() // re-render when the clipboard changes (cut rows dim / undim)
  useEffect(() => {
    let live = true
    void capabilities().then((caps) => { if (live) setOn(caps.mutate) })
    return () => { live = false }
  }, [epoch])
  useEffect(() => {
    if (on) enabled.add(c.nodeId)
    else if (on === false) locked.add(c.nodeId)
    return () => { enabled.delete(c.nodeId); locked.delete(c.nodeId); clearUi(c.nodeId) }
  }, [on, c.nodeId])
  useEffect(() => () => clearUndo(c.nodeId), [c.nodeId])
  useReloadOnLocalChange(c)
  // Konfirmasi adalah pertanyaan tentang satu folder; pindah folder membatalkannya.
  useEffect(() => { setConfirm(c.nodeId, null) }, [c.cwd, c.nodeId])
}

export const mutateSlot: FilesSlot = {
  id: 'mutate',
  menu,
  onKey,
  useSlot,
  decorate: decorateCut,
  overlay: (c) => <><FilesMutateOverlay nodeId={c.nodeId} /><FilesWriteOffer nodeId={c.nodeId} /></>,
}
