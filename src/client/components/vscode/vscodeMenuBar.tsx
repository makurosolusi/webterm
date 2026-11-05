import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import './vscode-shell.css'
import './vscode-overlay.css'
import './vscode-menu.css'

export interface VscodeMenuBarItem {
  type?: 'item'
  id: string
  label: string
  icon?: ReactNode
  keybinding?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  submenu?: VscodeMenuEntry[]
  onSelect?: () => void
}

export interface VscodeMenuSeparator {
  type: 'separator'
}

export interface VscodeMenuHeader {
  type: 'header'
  label: string
}

export type VscodeMenuEntry = VscodeMenuBarItem | VscodeMenuSeparator | VscodeMenuHeader

export interface VscodeMenu {
  id: string
  label: string
  items: VscodeMenuEntry[]
}

export interface VscodeMenuBarProps {
  menus: VscodeMenu[]
  /** Controlled open menu id; `null` closes every menu. */
  openId?: string | null
  onOpenChange: (id: string | null) => void
  className?: string
  ariaLabel?: string
}

const ITEM_INDENT = 'var(--vscode-menu-item-indent, 8px)'

function isItem(entry: VscodeMenuEntry): entry is VscodeMenuBarItem {
  return entry.type === undefined || entry.type === 'item'
}

function itemRole(entry: VscodeMenuBarItem): string {
  if (entry.submenu) return 'menuitem'
  if (entry.checked !== undefined) return 'menuitemcheckbox'
  return 'menuitem'
}

interface MenuListProps {
  entries: VscodeMenuEntry[]
  ariaLabel: string
  level: number
  onActivate: (entry: VscodeMenuBarItem) => void
  /** Escape, or ArrowLeft when nested, closes one level. */
  onClose: () => void
  /** ArrowLeft at the top level moves to the previous top-level menu. */
  onMoveMenu: (delta: 1 | -1) => void
}

/**
 * One rendered menu panel with roving focus. Disabled rows stay focusable so they
 * remain readable, matching VS Code; only activation is blocked.
 */
function MenuList({ entries, ariaLabel, level, onActivate, onClose, onMoveMenu }: MenuListProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [active, setActive] = useState(() => entries.findIndex(isItem))
  const initialFocus = useRef(false)

  const focusAt = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    setActive(index)
    itemRefs.current[index]?.focus()
  }

  const move = (delta: 1 | -1) => {
    if (entries.length === 0) return
    let next = active
    for (let step = 0; step < entries.length; step += 1) {
      next = (next + delta + entries.length) % entries.length
      if (isItem(entries[next])) {
        focusAt(next)
        return
      }
    }
  }

  useEffect(() => {
    if (initialFocus.current) return
    initialFocus.current = true
    if (active >= 0) itemRefs.current[active]?.focus()
  }, [active])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
        focusAt(entries.findIndex(isItem))
        break
      case 'End': {
        event.preventDefault()
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (isItem(entries[index])) {
            focusAt(index)
            break
          }
        }
        break
      }
      case 'Enter':
      case ' ': {
        const entry = entries[active]
        if (entry && isItem(entry)) {
          event.preventDefault()
          onActivate(entry)
        }
        break
      }
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        onClose()
        break
      case 'ArrowLeft':
        event.preventDefault()
        event.stopPropagation()
        if (level > 0) onClose()
        else onMoveMenu(-1)
        break
      case 'ArrowRight':
        // Rows with a submenu handle this themselves and stop propagation.
        if (level === 0) {
          event.preventDefault()
          event.stopPropagation()
          onMoveMenu(1)
        }
        break
      default:
        break
    }
  }

  return (
    <div className="vscode-menu__list" role="menu" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {entries.map((entry, index) => {
        if (!entry.type || entry.type === 'item') {
          const item = entry as VscodeMenuBarItem
          return (
            <MenuRow
              key={`${item.id}-${index}`}
              entry={item}
              index={index}
              indent={ITEM_INDENT}
              registerRef={(element) => {
                itemRefs.current[index] = element
              }}
              onFocus={() => setActive(index)}
              onActivate={onActivate}
              onClose={onClose}
              level={level}
            />
          )
        }
        if (entry.type === 'separator') {
          return <div key={`separator-${index}`} role="separator" className="vscode-menu__separator" />
        }
        return (
          <div key={`header-${entry.label}-${index}`} role="presentation" className="vscode-menu__header">
            {entry.label}
          </div>
        )
      })}
    </div>
  )
}

interface MenuRowProps {
  entry: VscodeMenuBarItem
  index: number
  indent: string
  registerRef: (element: HTMLButtonElement | null) => void
  onFocus: () => void
  onActivate: (entry: VscodeMenuBarItem) => void
  onClose: () => void
  level: number
}

function MenuRow({ entry, index, indent, registerRef, onFocus, onActivate, onClose, level }: MenuRowProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const hasSubmenu = Boolean(entry.submenu?.length)
  const disabled = Boolean(entry.disabled)

  const closeSubmenu = () => {
    setSubmenuOpen(false)
    buttonRef.current?.focus()
  }

  const activate = () => {
    if (disabled) return
    if (hasSubmenu) {
      setSubmenuOpen((open) => !open)
      return
    }
    onActivate(entry)
  }

  return (
    <div role="none" className="vscode-menu-bar__row">
      <button
        ref={(element) => {
          buttonRef.current = element
          registerRef(element)
        }}
        type="button"
        role={itemRole(entry)}
        data-slot="vscode-menu-item"
        data-danger={entry.danger ? 'true' : 'false'}
        data-disabled={disabled ? 'true' : 'false'}
        data-submenu={hasSubmenu ? 'true' : 'false'}
        className="vscode-menu__item"
        style={{ paddingLeft: indent }}
        aria-disabled={disabled || undefined}
        aria-checked={entry.checked}
        aria-haspopup={hasSubmenu ? 'menu' : undefined}
        aria-expanded={hasSubmenu ? submenuOpen : undefined}
        tabIndex={index === 0 ? 0 : -1}
        onFocus={onFocus}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && hasSubmenu) {
            event.preventDefault()
            event.stopPropagation()
            setSubmenuOpen(true)
          } else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && submenuOpen) {
            event.preventDefault()
            event.stopPropagation()
            closeSubmenu()
          }
        }}
      >
        <span className="vscode-menu__icon" aria-hidden="true">
          {entry.icon ?? (entry.checked ? <span className="codicon codicon-check" /> : null)}
        </span>
        <span className="vscode-menu__label">{entry.label}</span>
        {entry.keybinding ? <span className="vscode-menu__keybinding">{entry.keybinding}</span> : null}
        {hasSubmenu ? (
          <span className="vscode-menu__submenu-caret codicon codicon-chevron-right" aria-hidden="true" />
        ) : null}
      </button>
      {hasSubmenu && submenuOpen ? (
        <div className="vscode-menu__submenu">
          <MenuList
            entries={entry.submenu ?? []}
            ariaLabel={entry.label}
            level={level + 1}
            onActivate={onActivate}
            onClose={closeSubmenu}
            onMoveMenu={() => closeSubmenu()}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * VS Code menu bar: a 35px row of 13px labels with `0 8px` padding. The open menu is
 * controlled (`openId` / `onOpenChange`); hover only switches menus while one is
 * already open, matching VS Code.
 *
 * Keyboard: ArrowDown/Enter/Space opens, ArrowLeft/ArrowRight move between top-level
 * menus (opening the next one when a menu is open), Escape closes, and inside a menu
 * ArrowUp/ArrowDown/Home/End move, Enter/Space activate, ArrowRight opens a submenu,
 * ArrowLeft closes it or moves to the previous top-level menu. A lone Alt press focuses
 * the first menu.
 */
export function VscodeMenuBar({
  menus,
  openId = null,
  onOpenChange,
  className,
  ariaLabel = 'Application menu',
}: VscodeMenuBarProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const uid = useId()
  const openMenu = menus.find((menu) => menu.id === openId) ?? null

  // Clicking outside the bar and its menus dismisses them. A pointerdown listener
  // (not click) matches how native menus close before the underlying control reacts.
  useEffect(() => {
    if (!openMenu) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(null)
    }
    // Capture phase: d3-zoom (React Flow pane) stopImmediatePropagation()s mousedown, so a bubble listener on document never sees a canvas click.
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [openMenu, onOpenChange])

  // VS Code: a lone Alt press (no other key in between) moves focus to the menu bar.
  // Ignored while typing in a field or terminal (xterm's helper is a textarea) so a
  // bare Alt never steals focus from them.
  useEffect(() => {
    let alone = false
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      alone = event.key === 'Alt' && !event.repeat
    }
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const typing = target?.closest('input, textarea, select, [contenteditable]') != null
      if (event.key === 'Alt' && alone && !typing) {
        buttonRefs.current.values().next().value?.focus()
      }
      alone = false
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const switchMenu = (delta: 1 | -1) => {
    if (!openMenu) return
    const index = menus.findIndex((menu) => menu.id === openMenu.id)
    const next = menus[(index + delta + menus.length) % menus.length]
    if (next) onOpenChange(next.id)
  }

  const activate = (entry: VscodeMenuBarItem) => {
    if (entry.disabled) return
    entry.onSelect?.()
    onOpenChange(null)
    if (openMenu) buttonRefs.current.get(openMenu.id)?.focus()
  }

  const closeMenu = () => {
    const currentId = openMenu?.id
    onOpenChange(null)
    if (currentId) buttonRefs.current.get(currentId)?.focus()
  }

  return (
    <div
      ref={rootRef}
      className={['vscode-menu-bar', className].filter(Boolean).join(' ')}
      role="menubar"
      aria-label={ariaLabel}
    >
      {menus.map((menu, index) => {
        const open = menu.id === openId
        const panelId = `${uid}-${menu.id}-menu`
        return (
          <div key={menu.id} className="vscode-menu-bar__anchor">
            <button
              ref={(element) => {
                if (element) buttonRefs.current.set(menu.id, element)
                else buttonRefs.current.delete(menu.id)
              }}
              type="button"
              role="menuitem"
              data-slot="vscode-menu-bar-item"
              data-open={open ? 'true' : 'false'}
              className="vscode-menu-bar__item"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              tabIndex={open || (openId === null && index === 0) ? 0 : -1}
              onMouseEnter={() => {
                if (openId !== null && openId !== menu.id) onOpenChange(menu.id)
              }}
              onClick={() => {
                if (open) closeMenu()
                else onOpenChange(menu.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault()
                  const delta = event.key === 'ArrowRight' ? 1 : -1
                  const next = menus[(index + delta + menus.length) % menus.length]
                  if (!next) return
                  buttonRefs.current.get(next.id)?.focus()
                  if (openId !== null) onOpenChange(next.id)
                  return
                }
                if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (!open) onOpenChange(menu.id)
                  else rootRef.current?.querySelector<HTMLElement>('[role="menu"] [role^="menuitem"]')?.focus()
                  return
                }
                if (event.key === 'Escape' && openId !== null) {
                  event.preventDefault()
                  closeMenu()
                }
              }}
            >
              {menu.label}
            </button>
            {open ? (
              <div id={panelId} className="vscode-menu-bar__panel">
                <MenuList
                  entries={menu.items}
                  ariaLabel={menu.label}
                  level={0}
                  onActivate={activate}
                  onClose={closeMenu}
                  onMoveMenu={switchMenu}
                />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
