import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './vscode-overlay.css'

const VIEWPORT_MARGIN = 8
const SUBMENU_OVERLAP = 4
const TYPEAHEAD_BUFFER_MS = 500

export type VscodeMenuItem =
  | {
      type: 'item'
      id: string
      label: string
      icon?: ReactNode
      keybinding?: string
      disabled?: boolean
      /** Destructive action: error foreground on text and icon, never a fill. */
      danger?: boolean
      checked?: boolean
      submenu?: VscodeMenuItem[]
      onSelect?: () => void
    }
  | { type: 'separator' }
  | { type: 'header'; label: string }

export interface VscodeMenuProps {
  open: boolean
  /** Viewport coordinates, normally the context-menu pointer position. */
  anchor: { x: number; y: number }
  items: VscodeMenuItem[]
  onClose: () => void
  /** Default 160px. */
  minWidth?: number
  ariaLabel?: string
}

/**
 * Open-menu registry. Submenus are separate portals, so a parent panel's
 * `contains(target)` check cannot see them. Outside clicks consult every open
 * panel, and an outside click closes the whole tree at once.
 */
interface MenuEntry {
  root: HTMLElement
  close: () => void
}

const menuEntries: MenuEntry[] = []

function registerMenu(entry: MenuEntry): void {
  menuEntries.push(entry)
}

function unregisterMenu(entry: MenuEntry): void {
  const index = menuEntries.indexOf(entry)
  if (index >= 0) menuEntries.splice(index, 1)
}

function closeAllMenus(): void {
  for (const entry of [...menuEntries].reverse()) entry.close()
}

function pointerInsideMenu(target: Node): boolean {
  return menuEntries.some((entry) => entry.root.contains(target))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function focusableIndices(items: VscodeMenuItem[]): number[] {
  return items.flatMap((item, index) => (item.type === 'item' ? [index] : []))
}

interface MenuPanelProps {
  x: number
  y: number
  items: VscodeMenuItem[]
  minWidth: number
  ariaLabel?: string
  level: number
  onClose: () => void
}

function MenuPanel({ x, y, items, minWidth, ariaLabel, level, onClose }: MenuPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement | null>())
  const activeRef = useRef(-1)
  const submenuRef = useRef<number | null>(null)
  const [active, setActive] = useState(-1)
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null)
  const [position, setPosition] = useState({ top: y, left: x })
  const typeahead = useRef('')
  const typeaheadTimer = useRef<number | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  activeRef.current = active
  submenuRef.current = submenuIndex

  const setActiveRow = (index: number) => {
    // Moving off a submenu row closes the open child, matching VS Code.
    if (submenuRef.current !== null && submenuRef.current !== index) setSubmenuIndex(null)
    setActive(index)
    itemRefs.current.get(index)?.focus()
  }

  const move = (delta: number) => {
    const rows = focusableIndices(items)
    if (rows.length === 0) return
    const current = rows.indexOf(activeRef.current)
    const next = current < 0 ? (delta > 0 ? 0 : rows.length - 1) : (current + delta + rows.length) % rows.length
    setActiveRow(rows[next])
  }

  const openSubmenu = (index: number) => {
    const row = items[index]
    if (row.type !== 'item' || row.disabled || !row.submenu?.length) return
    setActiveRow(index)
    setSubmenuIndex(index)
  }

  const activate = (index: number) => {
    const row = items[index]
    if (!row || row.type !== 'item' || row.disabled) return
    if (row.submenu?.length) {
      openSubmenu(index)
      return
    }
    row.onSelect?.()
    closeAllMenus()
  }

  // Mount: capture the trigger for focus return, register with the outside-click
  // registry, and focus the first row.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const entry: MenuEntry = { root, close: () => closeRef.current() }
    registerMenu(entry)

    const rows = focusableIndices(items)
    if (rows.length > 0) {
      setActive(rows[0])
      itemRefs.current.get(rows[0])?.focus()
    } else {
      root.focus()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (pointerInsideMenu(event.target as Node)) return
      closeAllMenus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      unregisterMenu(entry)
      if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current)
      if (previous?.isConnected) previous.focus()
    }
    // Mount-only: items identity can change while a menu is open, and re-running
    // this would re-register and steal focus on every parent render.
  }, [])

  // Flip/shift so the panel stays inside the viewport with an 8px margin.
  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    const width = element.offsetWidth || minWidth
    const height = element.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + width > vw - VIEWPORT_MARGIN) left = x - width
    if (top + height > vh - VIEWPORT_MARGIN) top = y - height
    setPosition({
      left: clamp(left, VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN),
      top: clamp(top, VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN),
    })
  }, [x, y, minWidth, items.length])

  const runTypeahead = (key: string) => {
    typeahead.current += key.toLowerCase()
    if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current)
    typeaheadTimer.current = window.setTimeout(() => {
      typeahead.current = ''
    }, TYPEAHEAD_BUFFER_MS)

    const rows = focusableIndices(items)
    const match = rows.find((index) => {
      const row = items[index]
      return row.type === 'item' && row.label.toLowerCase().startsWith(typeahead.current)
    })
    if (match !== undefined) setActiveRow(match)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        if (focusableIndices(items).length > 0) setActiveRow(focusableIndices(items)[0])
        break
      case 'End': {
        event.preventDefault()
        const rows = focusableIndices(items)
        if (rows.length > 0) setActiveRow(rows[rows.length - 1])
        break
      }
      case 'ArrowRight':
        event.preventDefault()
        openSubmenu(activeRef.current)
        break
      case 'ArrowLeft':
        if (level > 0) {
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        activate(activeRef.current)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        break
      case 'Tab':
        closeAllMenus()
        break
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          runTypeahead(event.key)
        }
    }
  }

  const submenuRow = submenuIndex === null ? null : items[submenuIndex]
  const submenuItems = submenuRow?.type === 'item' ? submenuRow.submenu ?? [] : []
  const submenuRect = submenuIndex === null ? null : itemRefs.current.get(submenuIndex)?.getBoundingClientRect() ?? null

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      tabIndex={-1}
      data-slot="vscode-menu"
      data-level={level}
      className="vscode-menu"
      style={{ top: position.top, left: position.left, minWidth }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.type === 'separator') {
          return (
            <div
              key={`separator-${index}`}
              role="separator"
              data-slot="vscode-menu-separator"
              className="vscode-menu__separator"
            />
          )
        }
        if (item.type === 'header') {
          return (
            <div
              key={`header-${index}-${item.label}`}
              role="presentation"
              data-slot="vscode-menu-header"
              className="vscode-menu__header"
            >
              {item.label}
            </div>
          )
        }

        const hasSubmenu = Boolean(item.submenu?.length)
        const checked = item.checked !== undefined
        return (
          <button
            key={item.id}
            ref={(node) => {
              itemRefs.current.set(index, node)
            }}
            type="button"
            role={checked ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={checked ? item.checked : undefined}
            aria-disabled={item.disabled ? 'true' : undefined}
            aria-haspopup={hasSubmenu ? 'menu' : undefined}
            aria-expanded={hasSubmenu ? submenuIndex === index : undefined}
            tabIndex={active === index ? 0 : -1}
            data-slot="vscode-menu-row"
            data-index={index}
            data-active={active === index}
            data-danger={item.danger ? 'true' : undefined}
            className="vscode-menu__row"
            onClick={() => activate(index)}
            onPointerEnter={() => {
              setActiveRow(index)
              if (hasSubmenu && !item.disabled) setSubmenuIndex(index)
            }}
          >
            <span className="vscode-menu__icon" aria-hidden="true">
              {item.checked ? '✓' : item.icon}
            </span>
            <span className="vscode-menu__label">{item.label}</span>
            {item.keybinding && (
              <span className="vscode-menu__keybinding" aria-hidden="true">
                {item.keybinding}
              </span>
            )}
            {hasSubmenu && (
              <span className="vscode-menu__submenu-caret" aria-hidden="true">
                ›
              </span>
            )}
          </button>
        )
      })}

      {submenuIndex !== null && submenuItems.length > 0 && submenuRect && (
        <MenuPanel
          x={submenuRect.right - SUBMENU_OVERLAP}
          y={submenuRect.top - SUBMENU_OVERLAP}
          items={submenuItems}
          minWidth={minWidth}
          ariaLabel={ariaLabel ? `${ariaLabel} submenu` : undefined}
          level={level + 1}
          onClose={() => {
            setSubmenuIndex(null)
            itemRefs.current.get(submenuIndex)?.focus()
          }}
        />
      )}
    </div>,
    document.body,
  )
}

/**
 * VS Code menu: portal to body at `anchor`, 22px rows, 160px default minimum,
 * 16px icon column, right-aligned keybindings, separators, headers, disabled and
 * danger rows, roving focus, type-ahead, and submenus that flip inside the viewport.
 *
 * Escape closes one level and returns focus to the row/trigger that opened it.
 */
export function VscodeMenu({ open, anchor, items, onClose, minWidth = 160, ariaLabel }: VscodeMenuProps) {
  if (!open) return null
  return (
    <MenuPanel
      x={anchor.x}
      y={anchor.y}
      items={items}
      minWidth={minWidth}
      ariaLabel={ariaLabel}
      level={0}
      onClose={onClose}
    />
  )
}
