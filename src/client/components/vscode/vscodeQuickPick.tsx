import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import './vscode-quick-pick.css'
import { customRank, defaultRank, highlightSegments } from './vscodeQuickPickRanking'

export interface VscodeQuickPickItem {
  id: string
  label: string
  description?: string
  detail?: string
  keybinding?: string
  icon?: ReactNode
  group?: string
  disabled?: boolean
}

export interface VscodeQuickPickProps {
  open: boolean
  onClose: () => void
  placeholder: string
  items: VscodeQuickPickItem[]
  onSelect: (id: string) => void
  /** Optional caller ranking. Lower score is better; `null` hides the row. */
  rank?: (item: VscodeQuickPickItem, query: string) => number | null
  emptyText?: string
  /** Accessible name for the dialog; defaults to the placeholder. */
  ariaLabel?: string
  /** Footer hint; pass an empty string to hide it. */
  hint?: string
  /**
   * Mode prefix (VS Code uses `>` for commands). A query starting with it is ranked
   * without the prefix, so typing it keeps the list instead of emptying it.
   */
  modePrefix?: string
}

const DEFAULT_HINT = 'Press Enter to confirm or Escape to cancel'
/** Rows visible before the list scrolls (max-height 440px / 22px rows). */
const VISIBLE_ROWS = 20

function firstEnabledIndex(items: VscodeQuickPickItem[]): number {
  return items.findIndex((item) => !item.disabled)
}

/**
 * VS Code quick pick / command palette.
 *
 * 600px wide, 6px below the title bar, 24px input, 22px rows, max 20 visible rows
 * (440px) before the list scrolls, matched characters highlighted, PgUp/PgDn paging. The input owns focus and points at the active row
 * through `aria-activedescendant`, so the listbox never needs its own tab stop.
 */
export function VscodeQuickPick({
  open,
  onClose,
  placeholder,
  items,
  onSelect,
  rank,
  emptyText = 'No matching commands',
  ariaLabel,
  hint = DEFAULT_HINT,
  modePrefix,
}: VscodeQuickPickProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const needle = modePrefix && query.startsWith(modePrefix) ? query.slice(modePrefix.length) : query
  const filtered = useMemo(
    () => (rank ? customRank(items, needle, rank) : defaultRank(items, needle)),
    [items, needle, rank],
  )

  // Reset the active row whenever the visible set changes (new query or new items).
  useEffect(() => {
    setActive(firstEnabledIndex(filtered))
  }, [filtered])

  // Keep the active row visible while arrowing through a scrolled list.
  useEffect(() => {
    if (open) rootRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, filtered])

  // Clear the query on close and focus the input on open. Query is kept while open.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(firstEnabledIndex(items))
      inputRef.current?.focus()
    } else {
      setQuery('')
    }
    // Only the open transition matters: re-running on a new `items` identity would
    // wipe the query the user is typing whenever the parent re-renders.
  }, [open])

  // Click outside the panel dismisses it, like the command palette.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClose])

  if (!open) return null

  const activeItem = filtered[active]

  /** Moves `distance` rows, skipping disabled rows ahead first, then falling back toward the current row. */
  const move = (direction: 1 | -1, distance = 1) => {
    const target = Math.min(filtered.length - 1, Math.max(0, active + direction * distance))
    const enabledFrom = (start: number, step: number, stop: number) => {
      for (let i = start; step > 0 ? i <= stop : i >= stop; i += step) if (!filtered[i].disabled) return i
      return -1
    }
    const edge = direction > 0 ? filtered.length - 1 : 0
    const ahead = enabledFrom(target, direction, edge)
    const next = ahead >= 0 && ahead !== active ? ahead : enabledFrom(target, -direction, active + direction)
    if (next >= 0 && next !== active) setActive(next)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'PageDown':
        event.preventDefault()
        move(1, VISIBLE_ROWS - 1)
        break
      case 'PageUp':
        event.preventDefault()
        move(-1, VISIBLE_ROWS - 1)
        break
      case 'Enter':
        event.preventDefault()
        if (activeItem && !activeItem.disabled) onSelect(activeItem.id)
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  let lastGroup: string | undefined
  const rows: ReactNode[] = []
  filtered.forEach((item, index) => {
    if (item.group && item.group !== lastGroup) {
      lastGroup = item.group
      rows.push(
        <div
          key={`group-${item.group}-${index}`}
          role="presentation"
          data-slot="vscode-quick-pick-group"
          className="vscode-quick-pick__group"
        >
          {item.group}
        </div>,
      )
    }
    const selected = index === active
    rows.push(
      <div
        key={item.id}
        id={`${listId}-option-${index}`}
        role="option"
        aria-selected={selected}
        aria-disabled={item.disabled || undefined}
        data-slot="vscode-quick-pick-item"
        data-active={selected ? 'true' : 'false'}
        data-disabled={item.disabled ? 'true' : 'false'}
        className="vscode-quick-pick__item"
        onMouseEnter={() => {
          if (!item.disabled) setActive(index)
        }}
        onClick={() => {
          if (!item.disabled) onSelect(item.id)
        }}
      >
        {item.icon ? (
          <span className="vscode-quick-pick__icon" data-slot="vscode-quick-pick-icon" aria-hidden="true">
            {item.icon}
          </span>
        ) : null}
        <span className="vscode-quick-pick__label" data-slot="vscode-quick-pick-label">
          {highlightSegments(item.label, needle).map((segment, i) =>
            segment.match ? (
              <span key={i} className="vscode-quick-pick__highlight" data-slot="vscode-quick-pick-highlight">
                {segment.text}
              </span>
            ) : (
              segment.text
            ),
          )}
        </span>
        {item.description ? (
          <span
            className="vscode-quick-pick__description"
            data-slot="vscode-quick-pick-description"
          >
            {item.description}
          </span>
        ) : null}
        {item.detail ? (
          <span className="vscode-quick-pick__detail" data-slot="vscode-quick-pick-detail">
            {item.detail}
          </span>
        ) : null}
        {item.keybinding ? (
          <span
            className="vscode-quick-pick__keybinding"
            data-slot="vscode-quick-pick-keybinding"
          >
            {item.keybinding}
          </span>
        ) : null}
      </div>,
    )
  })

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={ariaLabel ?? placeholder}
      data-slot="vscode-quick-pick"
      className="vscode-quick-pick"
    >
      <input
        ref={inputRef}
        role="combobox"
        type="text"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeItem ? `${listId}-option-${active}` : undefined
        }
        data-slot="vscode-quick-pick-input"
        className="vscode-quick-pick__input"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div
        id={listId}
        role="listbox"
        aria-label={placeholder}
        data-slot="vscode-quick-pick-list"
        className="vscode-quick-pick__list"
      >
        {filtered.length > 0 ? (
          rows
        ) : (
          <div
            role="presentation"
            data-slot="vscode-quick-pick-empty"
            className="vscode-quick-pick__empty"
          >
            {emptyText}
          </div>
        )}
      </div>
      {hint ? (
        <div role="presentation" data-slot="vscode-quick-pick-hint" className="vscode-quick-pick__hint">
          {hint}
        </div>
      ) : null}
    </div>
  )
}
