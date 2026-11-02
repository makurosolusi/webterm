// Keyboard model of the inbox list, matching a VS Code tree/list: one tab stop (roving
// tabindex), Up/Down/Home/End move focus, Left/Right collapse or expand a group header (Left on
// a row jumps to its header), Enter opens the row's action, Space toggles the row's selection.
import { useState } from 'react'
import type { KeyboardEvent } from 'react'

/** Row key of a group header; item rows use `r:<id>`. */
export const headerKey = (state: string): string => `h:${state}`

export interface InboxListKeyHandlers {
  /** Visible row keys in DOM order (headers and item rows). */
  keys: readonly string[]
  onToggleSection: (state: string) => void
  /** Collapse state of a header key, so Left/Right know the direction to go. */
  isCollapsed: (state: string) => boolean
  /** Header key that owns a row key (for Left on a row). */
  headerOf: (key: string) => string | null
  onToggleSelected: (itemId: string) => void
}

/** Roving-focus state plus the list-level key handler and focus tracker. */
export function useInboxListKeys(handlers: InboxListKeyHandlers) {
  const { keys } = handlers
  const [active, setActive] = useState<string | null>(null)
  const current = active !== null && keys.includes(active) ? active : keys[0] ?? null

  const focusKey = (list: HTMLElement, key: string | undefined): void => {
    if (key === undefined) return
    setActive(key)
    // Match by property, not selector: item ids are server strings and may hold quotes.
    Array.from(list.querySelectorAll<HTMLElement>('[data-row-key]')).find((el) => el.dataset.rowKey === key)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>('[data-row-key]')
    const key = row?.dataset.rowKey
    if (!row || key === undefined) return
    const list = event.currentTarget
    const index = keys.indexOf(key)
    const isHeader = key.startsWith('h:')
    const state = key.slice(2)
    const onRow = target === row
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusKey(list, keys[Math.min(keys.length - 1, index + 1)]); break
      case 'ArrowUp': event.preventDefault(); focusKey(list, keys[Math.max(0, index - 1)]); break
      case 'Home': event.preventDefault(); focusKey(list, keys[0]); break
      case 'End': event.preventDefault(); focusKey(list, keys[keys.length - 1]); break
      case 'ArrowRight':
        if (isHeader && handlers.isCollapsed(state)) { event.preventDefault(); handlers.onToggleSection(state) }
        break
      case 'ArrowLeft':
        if (!onRow) break
        if (isHeader) {
          if (!handlers.isCollapsed(state)) { event.preventDefault(); handlers.onToggleSection(state) }
        } else {
          const parent = handlers.headerOf(key)
          if (parent !== null) { event.preventDefault(); focusKey(list, parent) }
        }
        break
      case 'Enter':
        // Header rows are native buttons: the browser already turns Enter into a click.
        if (onRow && !isHeader) { event.preventDefault(); row.querySelector<HTMLButtonElement>('[data-inbox-open]')?.click() }
        break
      case ' ':
        if (onRow && !isHeader) { event.preventDefault(); handlers.onToggleSelected(key.slice(2)) }
        break
      default: break
    }
  }

  const onFocus = (event: React.FocusEvent<HTMLElement>): void => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-row-key]')?.dataset.rowKey
    if (key !== undefined) setActive(key)
  }

  return { current, onKeyDown, onFocus }
}
