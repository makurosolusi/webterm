// One tab strip for both layouts (Orca `tab-bar-surface.tsx` / `SortableTab.tsx`): tab mode's
// strip (switches the visible tab) and the node tab strip above the canvas (jumps to the node).
// One tab per node, the active one underlined, close on hover, middle-click close, double-click
// rename, drag reorder (only an insertion line moves, siblings stay put), arrow-key focus moves,
// tabs shrink before they overflow and the rest goes into a "⋯ N more" pick.
import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import type { SessionSignal } from './sessionSignal'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import TabOverflow, { useHiddenTabs } from './tabLayout.overflow'
import { withNodeName } from './nodeName.label'
import './tab-layout.css'

/** `signal`: status dot, from the selector the Sessions side bar uses (`nodeTabSignal`). */
/**
 * `title` is the editable label (the rename draft); `name` is the node's fixed name. The tab shows
 * the user's own title when `custom`, otherwise the name alone (VS Code: icon + name); the tooltip
 * always carries name, title and type.
 */
export interface TabItem { id: string; title: string; name?: string; /** `title` is a user rename, not a fallback (file name, kind). */ custom?: boolean; icon: string; signal?: SessionSignal; /** Node type label ("Browser"). */ kind?: string; /** Unsaved changes: a dot in place of the × until hover/focus. */ dirty?: boolean }

/** Tooltip: `name · title`, plus the node type when the title is not already the type. */
export const tabTooltip = (t: TabItem): string =>
  withNodeName(t.name, t.title) + (t.kind && t.kind !== t.title ? ` · ${t.kind}` : '')

export interface TabStripProps {
  items: TabItem[]
  active: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  /** Accessible name of the tablist. */
  label?: string
  /** Full new order after a drop. */
  onReorder: (order: string[]) => void
  /** Right-click, Shift+F10 or the ContextMenu key on a tab; `at` is the menu's viewport anchor. */
  onContextMenu?: (id: string, at: { x: number; y: number }) => void
  /** Right-hand controls (active tab's editor actions, new node menu, panel toggle). */
  children?: ReactNode
}

/** Tab index after an arrow/Home/End key, or -1 for any other key. */
export function nextTabIndex(key: string, at: number, count: number): number {
  if (key === 'ArrowRight') return (at + 1) % count
  if (key === 'ArrowLeft') return (at - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return -1
}

/** Order after dropping `from` on the left or right half of `to`. */
export function movedOrder(order: readonly string[], from: string, to: string, side: 'left' | 'right'): string[] {
  if (from === to) return [...order]
  const rest = order.filter((id) => id !== from)
  const at = rest.indexOf(to) + (side === 'right' ? 1 : 0)
  rest.splice(at, 0, from)
  return rest
}

export default function TabStrip({ items, active, onActivate, onClose, onRename, onReorder, onContextMenu, label = 'Open nodes', children }: TabStripProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const hidden = useHiddenTabs(listRef, items)
  const dragId = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    // jsdom has no scrollIntoView; browsers do. Also after a resize pushed the active tab out of view.
    listRef.current?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active, hidden.length])

  const commit = () => {
    const next = draft.trim()
    if (editing && next) onRename(editing, next)
    setEditing(null)
  }
  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (dragId.current === null) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const side = e.clientX < r.left + r.width / 2 ? 'left' : 'right'
    setDrop((d) => (d && d.id === id && d.side === side ? d : { id, side }))
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (dragId.current !== null && drop) onReorder(movedOrder(items.map((i) => i.id), dragId.current, drop.id, drop.side))
    dragId.current = null
    setDrop(null)
  }

  return (
    <div className="tabs-strip">
      <div
        ref={listRef} className="tabs-strip__list" role="tablist" aria-label={label}
        // Vertical wheel scrolls the strip sideways, like Orca's overflow strip.
        onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY }}
      >
        {items.map((t, i) => (
          <div
            // No active tab (canvas with nothing selected): the first one is the strip's tab stop.
            key={t.id} role="tab" aria-selected={t.id === active} tabIndex={t.id === (active ?? items[0]?.id) ? 0 : -1}
            className={cn('tabs-tab', t.id === active && 'tabs-tab--active', t.dirty && 'tabs-tab--dirty')}
            data-active={t.id === active ? '' : undefined} data-tab-id={t.id} data-drop={drop?.id === t.id ? drop.side : undefined}
            title={editing === t.id ? undefined : tabTooltip(t)}
            draggable={editing !== t.id}
            onClick={() => onActivate(t.id)}
            // Mouse anchors at the pointer; the keyboard (and the ContextMenu key's 0,0 event) under the tab.
            onContextMenu={(e) => {
              if (!onContextMenu || editing === t.id) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              onContextMenu(t.id, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom })
            }}
            // Middle button closes on mouseup (auxclick); mousedown would start browser autoscroll.
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
            onAuxClick={(e) => { if (e.button === 1 && editing !== t.id) { e.preventDefault(); onClose(t.id) } }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(t.id); return }
              if (onContextMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                onContextMenu(t.id, { x: r.left, y: r.bottom })
                return
              }
              const next = nextTabIndex(e.key, i, items.length)
              if (next < 0) return
              e.preventDefault()
              listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
            }}
            onDragStart={(e) => { dragId.current = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id) }}
            onDragOver={(e) => onDragOver(e, t.id)}
            onDrop={onDrop}
            onDragEnd={() => { dragId.current = null; setDrop(null) }}
          >
            <span className={cn('tabs-tab__icon codicon', `codicon-${t.icon}`)} aria-hidden="true" />
            {editing === t.id ? (
              <Input
                autoFocus className="tabs-tab__edit" aria-label="Rename tab" value={draft}
                onChange={(e) => setDraft(e.target.value)} onKeyDown={onEditKey} onBlur={commit}
                onClick={(e) => e.stopPropagation()} onFocus={(e) => e.currentTarget.select()}
              />
            ) : (
              <span className="tabs-tab__title" onDoubleClick={() => { setDraft(t.title); setEditing(t.id) }}>{t.custom ? t.title : t.name || t.title}</span>
            )}
            {t.signal && (
              <span className={cn('tabs-tab__status', `tabs-tab__status--${t.signal.tone}`)} role="img" aria-label={t.signal.label} />
            )}
            <span className="tabs-tab__end">
              {t.dirty && <span className="tabs-tab__dirty codicon codicon-circle-filled" role="img" aria-label="Unsaved changes" />}
              <IconButton
                label={`Close ${withNodeName(t.name, t.title)}`} side="bottom" size="icon-xs" className="tabs-tab__close"
                onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
              ><span className="codicon codicon-close" aria-hidden="true" /></IconButton>
            </span>
          </div>
        ))}
      </div>
      <div className="tabs-strip__actions">
        <TabOverflow items={items} hidden={hidden} onActivate={onActivate} />
        {children}
      </div>
    </div>
  )
}
