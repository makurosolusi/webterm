import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { rankTargets } from '@/CanvasToolbar'
import './vscode-controls.css'

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
}

function firstEnabledIndex(items: VscodeQuickPickItem[]): number {
  return items.findIndex((item) => !item.disabled)
}

function defaultRank(items: VscodeQuickPickItem[], query: string): VscodeQuickPickItem[] {
  if (!query.trim()) return items
  const byId = new Map(items.map((item) => [item.id, item]))
  const targets = items.map((item) => ({
    id: item.id,
    label: item.label,
    // Description and detail are searchable; the keybinding is not (matching VS Code).
    hint: [item.description, item.detail].filter(Boolean).join(' '),
  }))
  return rankTargets(targets, query, targets.length)
    .map((target) => byId.get(target.id))
    .filter((item): item is VscodeQuickPickItem => item !== undefined)
}

function customRank(
  items: VscodeQuickPickItem[],
  query: string,
  rank: NonNullable<VscodeQuickPickProps['rank']>,
): VscodeQuickPickItem[] {
  const scored: { item: VscodeQuickPickItem; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const score = rank(item, query)
    if (score !== null) scored.push({ item, score, index })
  })
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.map((entry) => entry.item)
}

/**
 * VS Code quick pick / command palette.
 *
 * 600px wide, 6px below the title bar, 24px input, 22px rows, max 20 visible rows
 * (440px) before the list scrolls. The input owns focus and points at the active row
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
}: VscodeQuickPickProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const filtered = useMemo(
    () => (rank ? customRank(items, query, rank) : defaultRank(items, query)),
    [items, query, rank],
  )

  // Reset the active row whenever the visible set changes (new query or new items).
  useEffect(() => {
    setActive(firstEnabledIndex(filtered))
  }, [filtered])

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

  const move = (direction: 1 | -1) => {
    let next = active
    for (let step = 0; step < filtered.length; step += 1) {
      next += direction
      if (next < 0 || next >= filtered.length) return
      if (!filtered[next].disabled) {
        setActive(next)
        return
      }
    }
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
          {item.label}
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
    </div>
  )
}
