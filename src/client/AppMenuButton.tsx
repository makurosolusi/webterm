// The app menu: ONE button (a hamburger) that opens File / View / Help as a cascading menu. It is drawn by the
// same `VscodeMenu` as every context menu, so there is one open submenu at a time (opening another closes the
// first), a submenu always sits beside its parent row (`vscodeMenu.place.ts`), and the keyboard, focus return and
// outside-click rules are the primitive's. This file only owns the button and where the first panel opens.
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import { menusAsRows, type VscodeMenu as VscodeMenuModel } from '@/components/vscode/vscodeMenu.model'
import { codicon } from './dockCodicon'

/** Gap between the button and the panel that opens beside it. */
export const MENU_ANCHOR_GAP_PX = 4
export const APP_MENU_LABEL = 'Menu'
export const APP_MENU_TOOLTIP = 'Menu: File, View and Help'

export interface AppMenuButtonProps {
  /** The File / View / Help model (`buildWorkspaceMenus`). */
  menus: VscodeMenuModel[]
  /** `rail`: an activity-bar item, the panel opens to its right. `bar`: a tab-row button, the panel opens below it. */
  variant?: 'rail' | 'bar'
}

export function AppMenuButton({ menus, variant = 'rail' }: AppMenuButtonProps) {
  const rail = variant === 'rail'
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const rows = useMemo(() => menusAsRows(menus), [menus])
  const isOpen = useRef(false)
  isOpen.current = anchor !== null
  // The menu closes itself on a pointerdown outside it, and the trigger counts as outside: without this the click
  // that follows a press on the open button would open the menu again. This listener is registered first, so it
  // sees the menu still open.
  const closedByPress = useRef(false)
  useEffect(() => {
    const onPress = (e: PointerEvent): void => {
      closedByPress.current = isOpen.current && e.target instanceof Node && buttonRef.current?.contains(e.target) === true
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [])

  const open = (): void => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setAnchor(rail ? { x: r.right + MENU_ANCHOR_GAP_PX, y: r.top } : { x: r.left, y: r.bottom + MENU_ANCHOR_GAP_PX })
  }
  const close = (): void => {
    setAnchor(null)
    buttonRef.current?.focus() // the trigger takes focus back whichever way the menu closed
  }

  // A lone Alt press (no other key between) moves focus to the button, like a menu bar. Ignored while typing in
  // a field or terminal (xterm's helper is a textarea) so a bare Alt never steals focus from them.
  useEffect(() => {
    let alone = false
    const onDown = (e: KeyboardEvent): void => { alone = e.key === 'Alt' && !e.repeat }
    const onUp = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]') !== null
      if (e.key === 'Alt' && alone && !typing) buttonRef.current?.focus()
      alone = false
    }
    document.addEventListener('keydown', onDown)
    document.addEventListener('keyup', onUp)
    return () => {
      document.removeEventListener('keydown', onDown)
      document.removeEventListener('keyup', onUp)
    }
  }, [])

  const common = {
    ref: buttonRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': anchor !== null,
    onClick: () => {
      if (closedByPress.current) closedByPress.current = false
      else if (anchor) close()
      else open()
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown' && !anchor) { e.preventDefault(); open() }
    },
  }
  return (
    <>
      {rail ? (
        <IconButton {...common} className="vscode-activity-bar__item dock-btn rounded-none" label={APP_MENU_LABEL} tooltip={APP_MENU_TOOLTIP} side="right" data-slot="app-menu-button">
          <span className="vscode-activity-bar__icon" aria-hidden>{codicon('menu')}</span>
        </IconButton>
      ) : (
        <IconButton {...common} className="app-tabs__action" label={APP_MENU_LABEL} tooltip={APP_MENU_TOOLTIP} data-slot="app-menu-button">
          <span className="codicon codicon-menu" aria-hidden />
        </IconButton>
      )}
      <VscodeMenu open={anchor !== null} anchor={anchor ?? { x: 0, y: 0 }} items={rows} onClose={close} ariaLabel={APP_MENU_LABEL} minWidth={200} />
    </>
  )
}
