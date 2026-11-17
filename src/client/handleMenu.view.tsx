// Searchable, grouped spawn list inside an anchored popover. Escape and click-outside are VscodePopover's;
// search, arrows and Enter live here. Rows reuse the quick pick's classes; the input owns focus and points
// at the active row (aria-activedescendant), like the quick pick.
import { useId, useMemo, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { VscodePopover } from './components/vscode/vscodePopover'
import { defaultRank } from './components/vscode/vscodeQuickPickRanking'
import './components/vscode/vscode-quick-pick.css'
import type { HandleEntry, HandleSide } from './handleMenu.model'

export const HANDLE_MENU_EMPTY = 'No match'

export interface HandleMenuViewProps {
  /** Screen point the menu hangs from (the handle, or where the cable was released). */
  point: { x: number; y: number }
  side: HandleSide
  entries: HandleEntry[]
  onPick: (entry: HandleEntry) => void
  onClose: () => void
  /** Dialog / search / list labels; default to the node spawner's. The skill list says "Add skill" instead. */
  title?: string
  placeholder?: string
  listLabel?: string
}

/** Anchored spawn menu: "Nodes" section; the right handle opens it to the right, the left handle to the left. */
export function HandleMenuView({ point, side, entries, onPick, onClose, title = 'Add connected node', placeholder = 'Search nodes', listLabel = 'Nodes' }: HandleMenuViewProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const listId = useId()
  const anchor = useMemo(() => ({ left: point.x, top: point.y, right: point.x, bottom: point.y, width: 0, height: 0 }) as DOMRect, [point.x, point.y])
  const shown = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]))
    return defaultRank(entries, query).flatMap((i) => byId.get(i.id) ?? [])
  }, [entries, query])

  // The remembered row if it survived the filter, else the first enabled one.
  const found = shown.findIndex((e) => e.id === activeId && !e.disabled)
  const active = found >= 0 ? found : shown.findIndex((e) => !e.disabled)
  const setActive = (i: number) => setActiveId(shown[i].id)

  const step = (dir: 1 | -1) => {
    for (let i = active + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return setActive(i)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const cur = shown[active]
      if (cur && !cur.disabled) onPick(cur)
    }
  }

  let lastGroup: string | undefined
  const rows: ReactNode[] = []
  shown.forEach((entry, index) => {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group
      rows.push(<div key={`g-${entry.group}`} role="presentation" className="vscode-quick-pick__group">{entry.group}</div>)
    }
    rows.push(
      <div
        key={entry.id}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === active}
        aria-disabled={entry.disabled || undefined}
        data-active={index === active ? 'true' : 'false'}
        data-disabled={entry.disabled ? 'true' : 'false'}
        className="vscode-quick-pick__item"
        onMouseEnter={() => { if (!entry.disabled) setActive(index) }}
        onClick={() => { if (!entry.disabled) onPick(entry) }}
      >
        {entry.dot && <span className="vscode-menu__dot" style={{ '--vscode-menu-dot-color': entry.dot } as CSSProperties} />}
        <span className="vscode-quick-pick__label">{entry.label}</span>
        {entry.description && <span className="vscode-quick-pick__detail">{entry.description}</span>}
      </div>,
    )
  })

  return (
    <VscodePopover anchor={anchor} open onOpenChange={(o) => { if (!o) onClose() }} placement={side === 'source' ? 'right' : 'left'} ariaLabel={title} className="handle-menu">
      <input
        role="combobox"
        type="text"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        className="vscode-quick-pick__input"
        onChange={(e) => { setQuery(e.target.value) }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-label={listLabel} className="vscode-quick-pick__list">
        {shown.length > 0 ? rows : <div role="presentation" className="vscode-quick-pick__empty">{HANDLE_MENU_EMPTY}</div>}
      </div>
    </VscodePopover>
  )
}
