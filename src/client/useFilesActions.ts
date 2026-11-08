// What the hand does in a Files node tree: pointer pick, context menu, and the keyboard (slots first,
// then `listKeyAction`, then type-to-find). Split out of FilesNode so the shell stays frame + state.
import { useRef, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react'
import type { FileMeta } from '../shared/fsContract'
import { childPath, parentDir } from './fileBrowse'
import type { PickMods } from './FilesList'
import { DEFAULT_PAGE_ROWS, listKeyAction, typeAhead, TYPEAHEAD_RESET_MS, type ListKeyAction } from './filesKeys'
import { nfcName, selectAll, selectOne, selectRange, toggleName, type Sel } from './filesSelection'
import { FILES_SLOTS, type FilesSlotCtx } from './filesSlots'
import { leafName, relParent, type TreeRow } from './filesTree'
import { relativePath } from './filesView'
import { revealPath } from './workspaceCreate/workspaceCreate.api'

/** Height of one `vscode-tree-item`; basis for PageUp/PageDown. */
const ROW_H = 22

export type Menu = { x: number; y: number; entry: FileMeta | null }

interface Deps {
  cwd: string
  /** Folder the node was created on: root of "Copy Relative Path". */
  root: string
  /** Visible (filtered) rows, display order. */
  rows: readonly TreeRow[]
  cursor: number
  sel: Sel
  setSel: Dispatch<SetStateAction<Sel>>
  query: string
  clearQuery: () => void
  listRef: RefObject<HTMLDivElement | null>
  ctx: FilesSlotCtx
  setMenu: (m: Menu | null) => void
  setNotice: (s: string) => void
  navigate: (to: string, cameFrom?: string) => void
  openFile: (path: string, opts: { focusEditor: boolean }) => void
}

/** DOM host of row `index` inside the list (rows carry `data-index`; the tree may be split around an input). */
export const rowElement = (list: HTMLElement | null, index: number): HTMLElement | null =>
  list?.querySelector<HTMLElement>(`vscode-tree-item[data-index="${index}"]`) ?? null

export function useFilesActions(d: Deps) {
  const typed = useRef({ buffer: '', at: 0 })
  const { rows, cursor, sel, setSel, ctx } = d

  const openRel = (rel: string, focusEditor: boolean) => d.openFile(childPath(d.cwd, rel), { focusEditor })

  /** Expand/collapse `rel`; collapsing over the cursor moves the cursor onto the folder (VS Code). */
  const toggle = (rel: string) => {
    if (ctx.expanded.has(rel) && sel.cursor?.startsWith(`${nfcName(rel)}/`)) setSel(selectOne(rel))
    ctx.toggle(rel)
  }

  const copy = (entry: FileMeta | null, relative: boolean) => {
    const target = entry ? childPath(d.cwd, entry.name) : d.cwd
    const text = relative ? relativePath(d.root, target) : target
    // The Clipboard API refuses in insecure contexts / without permission: say so, don't stay silent.
    navigator.clipboard?.writeText(text).catch(() => d.setNotice('Could not copy the path.'))
  }

  /** Show the entry in the OS file manager (Finder / File Explorer); the server runs it. */
  const reveal = (entry: FileMeta) => {
    revealPath(childPath(d.cwd, entry.name)).catch((e: unknown) =>
      d.setNotice(`Could not reveal “${leafName(entry.name)}”: ${e instanceof Error ? e.message : String(e)}`))
  }

  const onPick = (index: number, mods: PickMods) => {
    const r = rows[index]
    if (!r) return
    const shown = rows.map((x) => x.entry)
    setSel((s) => (mods.shift ? selectRange(s, shown, index) : mods.toggle ? toggleName(s, r.rel) : selectOne(r.rel)))
  }

  const onContext = (index: number | null, x: number, y: number) => {
    const r = index === null ? undefined : rows[index]
    // Right-click outside the selection selects that row; inside it, the selection is kept.
    if (r && !sel.names.has(nfcName(r.rel))) setSel(selectOne(r.rel))
    d.setMenu({ x, y, entry: r?.entry ?? null })
  }

  const run = (act: NonNullable<ListKeyAction>) => {
    const at = 'index' in act ? rows[act.index] : undefined
    const cur = rows[cursor]
    switch (act.kind) {
      case 'up': d.navigate(parentDir(d.cwd), d.cwd); break
      case 'open': if (at && !at.entry.dir) openRel(at.rel, !act.keepFocus); break
      case 'toggle': if (at) toggle(at.rel); break
      case 'select': if (at) setSel(act.extend ? selectRange(sel, rows.map((x) => x.entry), act.index) : selectOne(at.rel)); break
      case 'selectAll': setSel(selectAll(sel, rows.map((x) => x.entry))); break
      case 'copyPath': copy(cur?.entry ?? null, act.relative); break
      case 'reveal': if (cur) reveal(cur.entry); break
      case 'menu': {
        const rect = (rowElement(d.listRef.current, cursor) ?? d.listRef.current)?.getBoundingClientRect()
        d.setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0, entry: cur?.entry ?? null })
        break
      }
      // 'rename'/'delete'/'none': claimed so the canvas never sees them (Delete/Backspace would delete
      // the NODE); the mutate slot already acted on them through `onKey`, which runs first.
      default: break
    }
  }

  const onListKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    // React Flow hijacks the keyboard: arrows pan, and BACKSPACE/DELETE DELETE THIS NODE. Every key we
    // handle must be claimed here, not only preventDefault-ed.
    const claim = () => { ev.preventDefault(); ev.stopPropagation() }
    if (FILES_SLOTS.some((s) => s.onKey?.(ev, ctx))) { claim(); return }
    // Space inside a type-to-find word is part of the word ("my file"), not "open".
    const finding = ev.key === ' ' && typed.current.buffer !== '' && Date.now() - typed.current.at <= TYPEAHEAD_RESET_MS
    const box = d.listRef.current
    const page = box && box.clientHeight > 0 ? Math.floor(box.clientHeight / ROW_H) : DEFAULT_PAGE_ROWS
    const act = finding ? null : listKeyAction(
      { key: ev.key, code: ev.code, alt: ev.altKey, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey },
      cursor, rows, page,
    )
    if (act) { claim(); run(act); return }
    if (ev.key === 'Escape' && d.query) { claim(); d.clearQuery(); return }
    if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      claim()
      const next = typeAhead(typed.current, ev.key, Date.now(), rows.map((r) => leafName(r.rel)), cursor)
      typed.current = next.state
      if (next.index >= 0) setSel(selectOne(rows[next.index].rel))
    }
  }

  /** Folder a "New File/Folder" from the menu lands in, relative ('' = cwd): inside a folder, beside a file. */
  const createAt = (entry: FileMeta | null): string => (!entry ? '' : entry.dir ? entry.name : relParent(entry.name))

  return { onPick, onContext, onListKeyDown, toggle, openRel, copy, reveal, createAt }
}
