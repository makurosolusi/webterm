// Perilaku keyboard/mouse pohon sesi yang tidak dimiliki `vscode-tree`: Home/End, type-ahead,
// Delete (End Session), dan context menu (klik kanan, tombol Menu, Shift+F10). Dipasang NATIF di
// elemen `vscode-tree` — event dari dalam shadow tree tidak lewat delegasi React.
import { useEffect, useRef, type RefObject } from 'react'
import type { TreeTarget } from './SessionRow'
import { TYPEAHEAD_BUFFER_MS, edgeTarget, treeItemLabel, typeaheadTarget, visibleTreeItems } from './sessionsTreeNav'

export interface SessionsTreeEventHandlers {
  /** Elemen item → targetnya (peta milik panel). */
  resolve: (el: Element) => TreeTarget | undefined
  onEndSession: (id: string) => void
  onContextMenu: (target: TreeTarget, item: HTMLElement, anchor: { x: number; y: number }) => void
}

type FocusableItem = HTMLElement & { active?: boolean; updateComplete?: Promise<unknown> }

/** Pindahkan fokus roving ke item, memakai kontrak publik `active` milik library. */
function focusItem(item: FocusableItem): void {
  item.active = true
  void Promise.resolve(item.updateComplete).then(() => item.focus())
}

const isTypeaheadKey = (e: KeyboardEvent, buffer: string): boolean =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key !== ' ' || buffer !== '')

/** Pasang perilaku tambahan pada pohon; handler terbaru selalu dipakai tanpa memasang ulang listener. */
export function useSessionsTreeEvents(
  treeRef: RefObject<HTMLElement | null>,
  handlers: SessionsTreeEventHandlers,
  /** Panel tertutup tidak punya elemen pohon; ia dipasang ulang saat nilai ini berubah. */
  mounted: boolean,
): void {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    let buffer = ''
    let timer: number | undefined

    const itemOf = (e: Event): HTMLElement | null =>
      e.target instanceof Element ? e.target.closest<HTMLElement>('vscode-tree-item') : null

    const onKeyDown = (e: KeyboardEvent) => {
      // Tombol aksi di dalam baris (End session) punya Enter/Space sendiri.
      if (e.target instanceof Element && e.target.closest('button')) return
      const item = itemOf(e)
      const target = item ? ref.current.resolve(item) : undefined

      // Delete/Backspace berhenti di pohon: tanpa ini keyboard canvas menghapus node terpilih.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.stopPropagation()
        if (target?.kind === 'session' && (e.key === 'Delete' || e.metaKey)) {
          e.preventDefault()
          ref.current.onEndSession(target.id)
        }
        return
      }

      if (e.key === 'Home' || e.key === 'End') {
        const next = edgeTarget(e.key, visibleTreeItems(tree))
        if (!next) return
        e.preventDefault()
        e.stopPropagation()
        focusItem(next)
        return
      }

      if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && item && target) {
        e.preventDefault()
        e.stopPropagation()
        const rect = item.getBoundingClientRect()
        ref.current.onContextMenu(target, item, { x: rect.left + 24, y: rect.bottom })
        return
      }

      if (isTypeaheadKey(e, buffer)) {
        e.preventDefault()
        e.stopPropagation()
        buffer += e.key
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          buffer = ''
        }, TYPEAHEAD_BUFFER_MS)
        const items = visibleTreeItems(tree)
        const hit = typeaheadTarget(items.map(treeItemLabel), buffer, item ? items.indexOf(item) : -1)
        if (hit >= 0) focusItem(items[hit])
      }
    }

    const onContextMenu = (e: MouseEvent) => {
      const item = itemOf(e)
      const target = item ? ref.current.resolve(item) : undefined
      if (!item || !target) return
      e.preventDefault()
      focusItem(item)
      ref.current.onContextMenu(target, item, { x: e.clientX, y: e.clientY })
    }

    tree.addEventListener('keydown', onKeyDown)
    tree.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.clearTimeout(timer)
      tree.removeEventListener('keydown', onKeyDown)
      tree.removeEventListener('contextmenu', onContextMenu)
    }
  }, [treeRef, mounted])
}
