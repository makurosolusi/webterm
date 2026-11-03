// Daftar entri node files: wadah fokus tunggal (role="tree" + aria-activedescendant), handler
// pointer native, dan empat keadaan kosong yang sengaja tidak digabung.
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Button as VscodeButton, Tree } from '@/vscode/register'
import type { FileMeta } from '../shared/fsContract'
import { folderTitle } from './fileBrowse'
import { FilesRow } from './FilesRow'
import { nfcName, type Sel } from './filesSelection'
import type { Decoration } from './filesSlots'
import type { ListingVerdict } from './useFilesListing'

export const UNREACHABLE = 'Could not reach this folder. It may be gone, or its filesystem may be unavailable.'
export const UNAUTHORIZED = 'Access was denied (401). The session may have expired — reload the page or sign in again.'

export interface PickMods { shift: boolean; toggle: boolean }

interface Props {
  nodeId: string
  cwd: string
  shown: FileMeta[]
  total: number
  sel: Sel
  loading: boolean
  verdict: ListingVerdict | null
  query: string
  decorate: (e: FileMeta) => Decoration
  listRef: RefObject<HTMLDivElement | null>
  treeRef: RefObject<HTMLElement | null>
  /** Baris input inline (FilesInput), dirender di atas daftar. */
  inputRow?: ReactNode
  onPick: (index: number, mods: PickMods) => void
  onOpen: (index: number) => void
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
  const { shown, sel, loading, verdict, total, query } = p
  const empty = !loading && total === 0
  const cursorIdx = sel.cursor === null ? -1 : shown.findIndex((e) => nfcName(e.name) === sel.cursor)

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
      return index >= 0 && latest.current.shown[index] ? index : -1
    }
    const onClick = (ev: MouseEvent) => {
      const index = rowOf(ev)
      if (index < 0) return
      list.focus()
      latest.current.onPick(index, { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey })
    }
    const onDouble = (ev: MouseEvent) => {
      const index = rowOf(ev)
      if (index < 0) return
      latest.current.onPick(index, { shift: false, toggle: false })
      latest.current.onOpen(index)
    }
    const onContext = (ev: MouseEvent) => {
      const index = rowOf(ev)
      if (index < 0) return
      ev.preventDefault()
      ev.stopPropagation()
      latest.current.onContext(index, ev.clientX, ev.clientY)
    }
    list.addEventListener('click', onClick, true)
    list.addEventListener('dblclick', onDouble, true)
    list.addEventListener('contextmenu', onContext, true)
    return () => {
      list.removeEventListener('click', onClick, true)
      list.removeEventListener('dblclick', onDouble, true)
      list.removeEventListener('contextmenu', onContext, true)
    }
  }, [p.listRef])

  const retry = <VscodeButton onClick={p.onRetry}>Retry</VscodeButton>
  return (
    <div
      ref={p.listRef}
      className="files-list nodrag nowheel"
      role="tree"
      aria-label={`Files in ${folderTitle(p.cwd)}`}
      aria-multiselectable="true"
      aria-busy={loading}
      aria-activedescendant={cursorIdx >= 0 ? `files-${p.nodeId}-${cursorIdx}` : undefined}
      tabIndex={0}
      onKeyDown={p.onKeyDown}
      onContextMenu={(e) => { e.preventDefault(); p.onContext(null, e.clientX, e.clientY) }}
    >
      {p.inputRow}
      {/* Host tree hanya pengelompokan visual; role tree + fokus ada di wadah di atas. Wrapper React
          menjatuhkan prop `role`/`id`, jadi keduanya dipasang langsung pada elemen: tanpa ini ada dua
          `role=tree` bersarang. */}
      <Tree
        ref={(node) => { p.treeRef.current = node; node?.setAttribute('role', 'group'); node?.removeAttribute('aria-multiselectable') }}
        className="files-tree" hideArrows indentGuides="none"
      >
        {shown.map((e, i) => {
          const d = p.decorate(e)
          const key = nfcName(e.name)
          return (
            <FilesRow
              key={e.name} entry={e} index={i} domId={`files-${p.nodeId}-${i}`}
              selected={sel.names.has(key)} cursor={sel.cursor === key}
              badge={d.badge} decoTitle={d.title} decoClass={d.className}
            />
          )
        })}
      </Tree>

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
      {!loading && total > 0 && shown.length === 0 && (
        <div className="files-empty">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'All entries are hidden.'}</div>
      )}
    </div>
  )
}
