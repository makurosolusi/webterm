// OS file drop onto a Files node (VS Code Explorer): the whole node lights up, a folder row under the
// pointer becomes the only target, a file row or empty area means the current folder. A depth counter
// over dragenter/dragleave avoids flicker; Esc / leave / drop clear everything. Rows are found by event
// delegation (closest row element -> its `.files-name`), never per-row listeners. Visual state is
// written as data attributes, so React's className on the same elements is never fought over.
import { useEffect, useRef } from 'react'
import { childPath, folderTitle } from './fileBrowse'
import { DND_MIME } from './filesSlot.dnd'
import type { FilesSlotCtx } from './filesSlots'

/** Row attribute of the folder row that is the current drop target. */
export const DROP_ROW_ATTR = 'data-upload-drop-row'

/** True for a drag of OS files; internal path drags (`DND_MIME`) are not uploads. */
export function isOsFileDrag(dt: DataTransfer | null | undefined): dt is DataTransfer {
  const types = dt ? [...dt.types] : []
  return types.includes('Files') && !types.includes(DND_MIME)
}

/** Files of an OS drop; folders (directory entries) are skipped and their names returned separately. */
export function filesFromDrop(dt: DataTransfer): { files: File[]; skipped: string[] } {
  const files: File[] = []
  const skipped: string[] = []
  const items = [...(dt.items ?? [])].filter((it) => it.kind === 'file')
  if (items.length === 0) return { files: [...dt.files], skipped }
  for (const it of items) {
    const f = it.getAsFile()
    if (!f) continue
    if (it.webkitGetAsEntry?.()?.isDirectory) skipped.push(f.name)
    else files.push(f)
  }
  return { files, skipped }
}

export interface DropTarget { dir: string; row: Element | null }

/** Target under `target`: a folder row -> that folder (row highlighted); a file row or empty area -> `ctx.dir`. */
export function dropTargetAt(target: EventTarget | null, ctx: FilesSlotCtx): DropTarget {
  const hit = target instanceof Element ? target.closest('.files-row, vscode-tree-item[data-index]') : null
  const row = hit?.closest('vscode-tree-item') ?? hit
  const name = row?.querySelector('.files-name')?.textContent
  const entry = name ? ctx.entries.find((e) => e.name === name) : undefined
  return entry?.dir ? { dir: childPath(ctx.dir, entry.name), row: row ?? null } : { dir: ctx.dir, row: null }
}

/** Wire OS file drop on node `ctx.nodeId` while `on`; `onDrop` gets the target folder and the transfer. */
export function useUploadDrop(
  ctx: FilesSlotCtx, on: boolean, hint: (folder: string) => string,
  onDrop: (ctx: FilesSlotCtx, dir: string, dt: DataTransfer) => void,
): void {
  const live = useRef({ ctx, hint, onDrop })
  live.current = { ctx, hint, onDrop }
  useEffect(() => {
    const el = on ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(ctx.nodeId)}"]`) : null
    if (!el) return
    const body = el.querySelector<HTMLElement>('.files-node') ?? el
    let depth = 0
    let row: Element | null = null
    const paint = (t: DropTarget | null) => {
      if (row && row !== t?.row) row.removeAttribute(DROP_ROW_ATTR)
      row = t?.row ?? null
      if (!t) { delete body.dataset.uploadDrop; delete body.dataset.dropHint; return }
      row?.setAttribute(DROP_ROW_ATTR, '')
      body.dataset.uploadDrop = t.row ? 'row' : 'node'
      body.dataset.dropHint = live.current.hint(folderTitle(t.dir))
    }
    const clear = () => { depth = 0; paint(null) }
    const enter = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer)) return
      depth++
      paint(dropTargetAt(e.target, live.current.ctx))
    }
    const over = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      paint(dropTargetAt(e.target, live.current.ctx))
    }
    const leave = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) clear()
    }
    const drop = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      const { dir } = dropTargetAt(e.target, live.current.ctx)
      clear()
      live.current.onDrop(live.current.ctx, dir, e.dataTransfer)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') clear() }
    el.addEventListener('dragenter', enter)
    el.addEventListener('dragover', over)
    el.addEventListener('dragleave', leave)
    el.addEventListener('drop', drop)
    // A drop elsewhere on the page, or Esc, ends this drag too.
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
