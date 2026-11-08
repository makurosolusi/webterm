// Tree of a Files node: one focus container (role="tree" + aria-activedescendant), native pointer
// handlers (one click opens/toggles, double click renames), and four empty states kept apart.
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Button as VscodeButton, Tree } from '@/vscode/register'
import type { FileMeta } from '../shared/fsContract'
import { folderTitle } from './fileBrowse'
import { FilesRow } from './FilesRow'
import { nfcName, type Sel } from './filesSelection'
import type { Decoration } from './filesSlots'
import type { TreeRow } from './filesTree'
import type { ListingVerdict } from './useFilesListing'

export const UNREACHABLE = 'Could not reach this folder. It may be gone, or its filesystem may be unavailable.'
export const UNAUTHORIZED = 'Access was denied (401). The session may have expired — reload the page or sign in again.'

export interface PickMods { shift: boolean; toggle: boolean }

/** How long a single click on a FILE waits for a second click before opening it (a double click
 *  renames instead). Folders toggle at once: there is nothing to wait for. */
export const CLICK_OPEN_DELAY_MS = 250

/** Where the inline name input sits: `replace` = instead of row `rel` (rename), else first child
 *  under folder `rel` (create). Absent = top of the list. */
export interface InputAt { rel: string; replace: boolean }

interface Props {
  nodeId: string
  cwd: string
  /** Visible (filtered) tree rows. */
  rows: readonly TreeRow[]
  total: number
  sel: Sel
  loading: boolean
  verdict: ListingVerdict | null
  query: string
  decorate: (e: FileMeta) => Decoration
  listRef: RefObject<HTMLDivElement | null>
  treeRef: RefObject<HTMLElement | null>
  /** Inline name input (FilesInput), placed by `inputAt`. */
  inputRow?: ReactNode
  inputAt?: InputAt | null
  onPick: (index: number, mods: PickMods) => void
  onToggle: (rel: string) => void
  /** Single click on a file (after `CLICK_OPEN_DELAY_MS`): open it, focus stays in the tree. */
  onOpen: (rel: string) => void
  /** Double click: rename (never open). */
  onRename: (rel: string) => void
  onContext: (index: number | null, x: number, y: number) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onRetry: () => void
  onNewFile: () => void
}

/** Indeks baris dari event yang mendarat di konten slotted sebuah `vscode-tree-item`. Klik di area
 *  kosong baris di-retarget ke host item (shadow DOM), jadi host ikut membawa `data-index`. */
function rowIndexFrom(target: EventTarget | null): number {
  const row = target instanceof Element ? target.closest('.files-row, vscode-tree-item[data-index]') : null
  const raw = row?.getAttribute('data-index')
  return raw === null || raw === undefined ? -1 : Number(raw)
}

export default function FilesList(p: Props) {
  const { rows, sel, loading, verdict, total, query } = p
  const empty = !loading && total === 0
  const cursorIdx = sel.cursor === null ? -1 : rows.findIndex((r) => nfcName(r.rel) === sel.cursor)

  // Handler baris dipasang NATIVE di fase capture, SEKALI: klik di dalam `vscode-tree-item`
  // dihentikan komponen itu di shadow DOM sebelum naik ke root React, jadi `onClick` React tak
  // pernah melihatnya. Isinya selalu membaca props terbaru lewat ref, jadi tak perlu dipasang ulang
  // tiap render.
  const latest = useRef(p)
  latest.current = p
  useEffect(() => {
    const list = p.listRef.current
    if (!list) return
    const rowOf = (ev: Event) => {
      const index = rowIndexFrom(ev.target)
      return index >= 0 && latest.current.rows[index] ? index : -1
    }
    // One click opens, a double click renames (file manager model). A file's open waits for a possible
    // second click; the dblclick cancels it. A folder toggles on the first click; the dblclick toggles it
    // back, so a double click on a folder only renames. Clicks 2+ of a multi-click (detail > 1) are ignored.
    let pending: { timer: ReturnType<typeof setTimeout> } | null = null
    const cancel = () => { if (pending) clearTimeout(pending.timer); pending = null }
    const onClick = (ev: MouseEvent) => {
      const index = rowOf(ev)
      if (index < 0) return
      list.focus()
      if (ev.detail > 1) return
      cancel()
      const mods = { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey }
      latest.current.onPick(index, mods)
      if (mods.shift || mods.toggle) return
      const r = latest.current.rows[index]
      if (r.entry.dir) latest.current.onToggle(r.rel)
      else pending = { timer: setTimeout(() => { pending = null; latest.current.onOpen(r.rel) }, CLICK_OPEN_DELAY_MS) }
    }
    const onDouble = (ev: MouseEvent) => {
      const index = rowOf(ev)
      if (index < 0 || ev.shiftKey || ev.metaKey || ev.ctrlKey) return
      // The rename re-renders the row away before the event bubbles, so React Flow's `nopan` check
      // no longer finds the list and the canvas zooms in: the double click ends here.
      ev.stopPropagation()
      cancel()
      const r = latest.current.rows[index]
      if (r.entry.dir) latest.current.onToggle(r.rel)
      latest.current.onRename(r.rel)
    }
    const onContext = (ev: MouseEvent) => {
      const index = rowOf(ev)
      if (index < 0) return
      ev.preventDefault()
      ev.stopPropagation()
      cancel()
      latest.current.onContext(index, ev.clientX, ev.clientY)
    }
    list.addEventListener('click', onClick, true)
    list.addEventListener('dblclick', onDouble, true)
    list.addEventListener('contextmenu', onContext, true)
    return () => {
      cancel()
      list.removeEventListener('click', onClick, true)
      list.removeEventListener('dblclick', onDouble, true)
      list.removeEventListener('contextmenu', onContext, true)
    }
  }, [p.listRef])

  // Split point for the inline input: instead of row `rel` (rename) or right under folder `rel` (create).
  const atIdx = p.inputAt ? rows.findIndex((r) => r.rel === p.inputAt?.rel) : -1
  const inputHere = atIdx >= 0 && !!p.inputRow
  const replace = inputHere && !!p.inputAt?.replace
  const cut = !inputHere ? rows.length : replace ? atIdx : atIdx + 1
  const skip = replace ? 1 : 0
  const inputDepth = inputHere ? rows[atIdx].depth + (replace ? 0 : 1) : 0

  const renderTree = (part: readonly TreeRow[], offset: number, ref?: RefObject<HTMLElement | null>) => (
    <Tree
      ref={(node) => { if (ref) ref.current = node; node?.setAttribute('role', 'group'); node?.removeAttribute('aria-multiselectable') }}
      className="files-tree" hideArrows indentGuides="none"
    >
      {part.map((r, k) => {
        const i = offset + k
        const d = p.decorate(r.entry)
        const key = nfcName(r.rel)
        return (
          <FilesRow
            key={r.rel} entry={r.entry} index={i} domId={`files-${p.nodeId}-${i}`} depth={r.depth} open={r.open}
            selected={sel.names.has(key)} cursor={sel.cursor === key}
            badge={d.badge} decoTitle={d.title} decoClass={d.className}
          />
        )
      })}
    </Tree>
  )

  const retry = <VscodeButton onClick={p.onRetry}>Retry</VscodeButton>
  return (
    <div
      ref={p.listRef}
      className="files-list nodrag nowheel nopan"
      role="tree"
      aria-label={`Files in ${folderTitle(p.cwd)}`}
      aria-multiselectable="true"
      aria-busy={loading}
      aria-activedescendant={cursorIdx >= 0 ? `files-${p.nodeId}-${cursorIdx}` : undefined}
      tabIndex={0}
      onKeyDown={p.onKeyDown}
      onContextMenu={(e) => { e.preventDefault(); p.onContext(null, e.clientX, e.clientY) }}
    >
      {!inputHere && p.inputRow}
      {/* The tree host is visual grouping only; role tree + focus live on the container above. The
          React wrapper drops `role`, so it is set on the element: otherwise two `role=tree` nest.
          The inline input sits BETWEEN two hosts, never inside one: vscode-tree stops Enter/Escape/
          arrows natively, so an input inside it could neither commit nor cancel. */}
      {renderTree(rows.slice(0, cut), 0, p.treeRef)}
      {inputHere && (
        <div className="files-input-slot" style={{ '--files-depth': inputDepth } as CSSProperties}>{p.inputRow}</div>
      )}
      {cut + skip < rows.length && renderTree(rows.slice(cut + skip), cut + skip)}

      {/* Empat keadaan berbeda, sengaja TIDAK digabung: masing-masing menyuruh pengguna melakukan
          hal yang berbeda. */}
      {loading && <div className="files-empty">Loading…</div>}
      {empty && verdict === 'missing' && (
        <div className="files-empty files-empty--error" role="alert">
          <p>This folder no longer exists.</p>{retry}
        </div>
      )}
      {empty && verdict === 'unreachable' && (
        <div className="files-empty files-empty--error" role="alert"><p>{UNREACHABLE}</p>{retry}</div>
      )}
      {empty && verdict === 'auth' && (
        <div className="files-empty files-empty--error" role="alert"><p>{UNAUTHORIZED}</p>{retry}</div>
      )}
      {empty && (verdict === 'empty' || verdict === 'unknown') && (
        <div className="files-empty files-welcome">
          <p>This folder is empty.</p>
          <VscodeButton onClick={p.onNewFile}>New File…</VscodeButton>
        </div>
      )}
      {!loading && total > 0 && rows.length === 0 && (
        <div className="files-empty">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'All entries are hidden.'}</div>
      )}
    </div>
  )
}
