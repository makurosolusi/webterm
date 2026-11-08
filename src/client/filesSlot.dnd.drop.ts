// Drag inside the Files tree (VS Code Explorer): selected rows dropped on a folder row move there, on a
// file row into that file's folder, on empty space into cwd; Alt/Option copies. The target is lit with
// the depth counter of filesSlot.upload.drop (dragenter/dragleave), written as data attributes so React's
// className is never fought over. Name conflicts keep both ("a copy.txt", filesName.copyName): the copy
// verb cannot overwrite, and a drag that silently replaces a file is data loss. VS Code asks instead;
// ponytail: no Replace dialog yet, add one (askConflict pattern of filesSlot.upload.conflict) if users want it.
import { useEffect, useRef } from 'react'
import type { FileMeta } from '../shared/fsContract'
import { childPath, folderTitle, parentDir } from './fileBrowse'
import { copyName } from './filesName'
import type { Moved } from './filesMutate'
import type { FilesSlotCtx } from './filesSlots'
import { pushUndo } from './filesUndo'
import { emitFsEvent } from './fsEvents'
import { copy, list, rename } from './fsClient'

/** MIME of an internal tree drag: JSON array of absolute paths (works across Files nodes). */
export const MOVE_MIME = 'application/x-webterm-files'
/** Attribute on the folder row that is the current drop target. */
export const MOVE_ROW_ATTR = 'data-files-move-row'
export const DROP_TEXT = {
  move: (folder: string) => `Move to ‘${folder}’`,
  copy: (folder: string) => `Copy to ‘${folder}’`,
  intoSelf: (name: string) => `Cannot drop ‘${name}’ into itself.`,
  moved: (n: number, folder: string) => `Moved ${n === 1 ? '1 item' : `${n} items`} to ‘${folder}’.`,
  copied: (n: number, folder: string) => `Copied ${n === 1 ? '1 item' : `${n} items`} to ‘${folder}’.`,
  failed: (n: number) => `${n === 1 ? '1 item' : `${n} items`} could not be moved or copied.`,
} as const

const ROW_SEL = '.files-row, vscode-tree-item[data-index]'

/** Paths of the drag in progress in this window (dataTransfer is unreadable until drop). */
let dragged: string[] | null = null
export function setDragged(paths: string[] | null): void { dragged = paths }

/** Relative path a rendered row stands for: its label's `title` (FilesRow), the label itself = last segment. */
const relOf = (row: Element): string | undefined => row.querySelector('.files-name')?.getAttribute('title') ?? undefined

/** Tree entry of the row under `target`, plus its row. Matched by path, not `data-index`: the index counts
 *  the rendered (query-filtered) rows while `ctx.entries` holds every tree row. */
export function rowAt(target: EventTarget | null, ctx: FilesSlotCtx): { entry: FileMeta; row: Element } | null {
  const hit = target instanceof Element ? target.closest(ROW_SEL) : null
  const row = hit?.closest('vscode-tree-item') ?? hit
  const rel = row ? relOf(row) : undefined
  const entry = rel === undefined ? undefined : ctx.entries.find((e) => e.name === rel)
  return row && entry ? { entry, row } : null
}

export interface MoveTarget { dir: string; row: Element | null }

/** Folder row -> that folder; file row -> its folder (row lit when visible); empty space -> cwd. */
export function moveTargetAt(target: EventTarget | null, ctx: FilesSlotCtx, scope: ParentNode): MoveTarget {
  const hit = rowAt(target, ctx)
  if (!hit) return { dir: ctx.cwd, row: null }
  if (hit.entry.dir) return { dir: childPath(ctx.cwd, hit.entry.name), row: hit.row }
  const cut = hit.entry.name.lastIndexOf('/')
  if (cut < 0) return { dir: ctx.cwd, row: null }
  const parent = hit.entry.name.slice(0, cut)
  const label = scope.querySelector(`vscode-tree-item .files-name[title="${CSS.escape(parent)}"]`)
  return { dir: childPath(ctx.cwd, parent), row: label?.closest('vscode-tree-item') ?? null }
}

/** First source that would land inside itself (the folder or one of its descendants), if any. */
export function intoSelf(srcs: readonly string[], dir: string): string | undefined {
  return srcs.find((s) => dir === s || dir.startsWith(`${s}/`))
}

export interface TransferReport { done: string[]; failed: { name: string; error: string }[]; pairs: Moved[] }

/** Move/copy every source into `dir`; a move into its own folder is skipped; a taken name keeps both. */
export async function transfer(srcs: readonly string[], dir: string, mode: 'move' | 'copy'): Promise<TransferReport> {
  const out: TransferReport = { done: [], failed: [], pairs: [] }
  let taken: string[] | null = null
  const freeName = async (name: string) => {
    taken ??= (await list(dir)).map((e) => e.name)
    const next = copyName(name, taken)
    taken.push(next)
    return childPath(dir, next)
  }
  for (const src of srcs) {
    if (mode === 'move' && parentDir(src) === dir) continue
    const name = folderTitle(src)
    const op = (to: string) => (mode === 'copy' ? copy(src, to) : rename(src, to))
    let to = childPath(dir, name)
    if (to === src) to = await freeName(name) // copy into its own folder = duplicate
    let r = await op(to)
    if (!r.ok && r.code === 'EEXIST') r = await op((to = await freeName(name)))
    if (!r.ok) { out.failed.push({ name, error: r.error }); continue }
    out.done.push(to)
    out.pairs.push({ from: src, to })
    // Same events as paste (filesMutate): open editors follow a move, other Files nodes reload.
    emitFsEvent(mode === 'move' ? { kind: 'renamed', path: to, from: src, origin: 'local' } : { kind: 'created', path: to, origin: 'local' })
  }
  return out
}

/** Run a drop of `srcs` into `dir`, then report in the footer and refresh selecting the first result. */
export async function dropInto(ctx: FilesSlotCtx, srcs: readonly string[], dir: string, mode: 'move' | 'copy'): Promise<void> {
  const self = intoSelf(srcs, dir)
  if (self) { ctx.notify({ kind: 'error', text: DROP_TEXT.intoSelf(folderTitle(self)) }); return }
  const r = await transfer(srcs, dir, mode)
  // Cmd+Z in this node reverts the drop, like a paste (filesUndo).
  if (r.pairs.length) pushUndo(ctx.nodeId, mode === 'move' ? { kind: 'move', pairs: r.pairs } : { kind: 'copy', paths: r.pairs.map((p) => p.to) })
  if (r.failed.length) {
    const detail = r.failed.map((f) => `${f.name}: ${f.error}`).join('\n')
    console.error(`files dnd: ${mode} into ${folderTitle(dir)} failed`, detail)
    ctx.notify({ kind: 'error', text: DROP_TEXT.failed(r.failed.length), detail })
  } else if (r.done.length) {
    ctx.notify({ kind: 'info', text: (mode === 'copy' ? DROP_TEXT.copied : DROP_TEXT.moved)(r.done.length, folderTitle(dir)) })
  }
  const first = r.done[0]
  const base = ctx.cwd.replace(/\/+$/, '')
  ctx.refresh(first?.startsWith(`${base}/`) ? first.slice(base.length + 1) : undefined)
}

const isMoveDrag = (dt: DataTransfer | null | undefined): dt is DataTransfer => !!dt && [...dt.types].includes(MOVE_MIME)

/** Wire internal tree drops on node `ctx.nodeId` while `on`. */
export function useTreeDrop(ctx: FilesSlotCtx, on: boolean): void {
  const live = useRef(ctx)
  live.current = ctx
  useEffect(() => {
    const el = on ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(ctx.nodeId)}"]`) : null
    if (!el) return
    const body = el.querySelector<HTMLElement>('.files-node') ?? el
    let depth = 0
    let row: Element | null = null
    const paint = (t: MoveTarget | null, hint?: string) => {
      if (row && row !== t?.row) row.removeAttribute(MOVE_ROW_ATTR)
      row = t?.row ?? null
      row?.setAttribute(MOVE_ROW_ATTR, '')
      if (t) body.dataset.filesMove = t.row ? 'row' : 'node'
      else delete body.dataset.filesMove
      if (hint) body.dataset.dropHint = hint
      else delete body.dataset.dropHint
    }
    const clear = () => { depth = 0; paint(null) }
    /** Paint the target under the pointer; false = this target is refused (into itself / no-op move). */
    const track = (e: DragEvent): boolean => {
      const t = moveTargetAt(e.target, live.current, body)
      const self = dragged ? intoSelf(dragged, t.dir) : undefined
      if (self) { paint(null, DROP_TEXT.intoSelf(folderTitle(self))); return false }
      if (dragged && !e.altKey && dragged.every((s) => parentDir(s) === t.dir)) { paint(null); return false }
      paint(t, (e.altKey ? DROP_TEXT.copy : DROP_TEXT.move)(folderTitle(t.dir)))
      return true
    }
    const enter = (e: DragEvent) => { if (isMoveDrag(e.dataTransfer)) { depth++; track(e) } }
    const over = (e: DragEvent) => {
      if (!isMoveDrag(e.dataTransfer)) return
      const ok = track(e)
      e.dataTransfer.dropEffect = ok ? (e.altKey ? 'copy' : 'move') : 'none'
      if (ok) e.preventDefault()
    }
    const leave = (e: DragEvent) => {
      if (!isMoveDrag(e.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) clear()
    }
    const drop = (e: DragEvent) => {
      if (!isMoveDrag(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      const c = live.current
      const { dir } = moveTargetAt(e.target, c, body)
      clear()
      let parsed: unknown
      try { parsed = JSON.parse(e.dataTransfer.getData(MOVE_MIME)) } catch (err) {
        console.error('files dnd: unreadable drag payload', err)
        return
      }
      if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) return
      const srcs: string[] = parsed
      dropInto(c, srcs, dir, e.altKey ? 'copy' : 'move').catch((err: unknown) => {
        console.error(`files dnd: drop into ${folderTitle(dir)} failed`, err)
        c.notify({ kind: 'error', text: DROP_TEXT.failed(srcs.length), detail: String(err) })
      })
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') clear() }
    el.addEventListener('dragenter', enter)
    el.addEventListener('dragover', over)
    el.addEventListener('dragleave', leave)
    el.addEventListener('drop', drop)
    window.addEventListener('drop', clear)
    document.addEventListener('keydown', esc)
    return () => {
      el.removeEventListener('dragenter', enter)
      el.removeEventListener('dragover', over)
      el.removeEventListener('dragleave', leave)
      el.removeEventListener('drop', drop)
      window.removeEventListener('drop', clear)
      document.removeEventListener('keydown', esc)
      clear()
    }
  }, [on, ctx.nodeId])
}
