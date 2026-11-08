// File clipboard for Files nodes (Cmd+C / Cmd+X / Cmd+V): one store shared by every Files node, so
// copying/moving between nodes works. Holds ABSOLUTE paths; cut rows render dimmed until pasted
// (or Escape). Paste target = selected folder, else the selected file's folder, else cwd.
import { useSyncExternalStore } from 'react'
import './filesSlot.clipboard.css'
import { childPath } from './fileBrowse'
import type { FileMeta } from '../shared/fsContract'
import { TOAST } from './filesMessages'
import { leavesIn, parentRel, pasteMany } from './filesMutate'
import { relTo, reportFailures, scopeOf, toast, undoAction } from './filesMutate.report'
import { pushUndo, type UndoEntry } from './filesUndo'
import type { Decoration, FilesSlotCtx } from './filesSlots'

export interface Clip { mode: 'copy' | 'cut'; paths: string[] }
let clip: Clip | null = null
const listeners = new Set<() => void>()
function setClip(next: Clip | null): void { clip = next; listeners.forEach((l) => l()) }

export const getClip = (): Clip | null => clip
export const clearClip = (): void => setClip(null)
/** Re-render on clipboard change (cut dimming). */
export const useClip = (): Clip | null =>
  useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => clip)

export function putClip(c: FilesSlotCtx, mode: Clip['mode']): void {
  if (c.selection.length) setClip({ mode, paths: c.selection.map((rel) => childPath(c.dir, rel)) })
}

/** Folder (relative, '' = cwd) a paste lands in. */
export function pasteTarget(c: FilesSlotCtx): string {
  const sel = c.selection[0]
  const e = sel === undefined ? undefined : c.entries.find((x) => x.name === sel)
  if (!e) return ''
  return e.dir ? e.name : parentRel(e.name)
}

export async function paste(c: FilesSlotCtx): Promise<void> {
  const cur = clip
  if (!cur) return
  const s = scopeOf(c)
  const target = pasteTarget(c)
  const move = cur.mode === 'cut'
  const r = await pasteMany(cur.paths, target ? childPath(c.dir, target) : c.dir, move, leavesIn(s.existing, target))
  // A cut is consumed once anything moved; a copy can be pasted again.
  if (move && (r.done.length || r.failed.length === 0)) setClip(null)
  s.refresh(r.pairs[0] && relTo(s.dir, r.pairs[0].to))
  if (r.pairs.length) {
    const e: UndoEntry = move ? { kind: 'move', pairs: r.pairs } : { kind: 'copy', paths: r.pairs.map((p) => p.to) }
    pushUndo(c.nodeId, e)
    const title = move ? TOAST.moved(r.done.length, r.done[0]) : TOAST.pasted(r.done.length, r.done[0])
    toast(s, { severity: 'info', title, actions: undoAction(s, e) })
  }
  reportFailures(s, move ? 'move' : 'copy', r.failed, cur.paths.length)
}

/** Dim rows that are on the clipboard as a cut. */
export function decorateCut(entry: FileMeta, c: FilesSlotCtx): Decoration | undefined {
  return clip?.mode === 'cut' && clip.paths.includes(childPath(c.dir, entry.name)) ? { className: 'files-row--cut' } : undefined
}
