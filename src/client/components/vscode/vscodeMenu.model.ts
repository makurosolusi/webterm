// The declarative menu model (File / View / Help) and its conversion to the rows `VscodeMenu` draws. Builders
// (`workspaceBar.menus.ts`) write this shape; the rail's menu button maps it with `toMenuItems`.
import type { ReactNode } from 'react'
import type { VscodeMenuItem } from './vscodeMenu'

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

/** One top-level menu: its label and rows. */
export interface VscodeMenu {
  id: string
  label: string
  items: VscodeMenuEntry[]
}

/** Entries as `VscodeMenu` rows (submenus recursively). */
export function toMenuItems(entries: VscodeMenuEntry[]): VscodeMenuItem[] {
  return entries.map((entry): VscodeMenuItem => {
    if (entry.type === 'separator' || entry.type === 'header') return entry
    const { submenu, ...row } = entry
    return { ...row, type: 'item', ...(submenu ? { submenu: toMenuItems(submenu) } : {}) }
  })
}

/** The top-level menus as one list of rows, each menu a row that opens its own submenu (VS Code's compact menu). */
export function menusAsRows(menus: VscodeMenu[]): VscodeMenuItem[] {
  return menus.map((menu) => ({ type: 'item', id: menu.id, label: menu.label, submenu: toMenuItems(menu.items) }))
}
