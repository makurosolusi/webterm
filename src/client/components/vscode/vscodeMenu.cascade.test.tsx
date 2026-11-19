/** @vitest-environment jsdom */
// Cascading menus: ONE submenu open at a time, beside its parent row, keyboard-complete. This is the invariant the
// old per-row `submenuOpen` state broke (View and Help open at once, drawn over each other).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../vscode/test-setup'
import { VscodeMenu, type VscodeMenuItem } from './vscodeMenu'

const row = (id: string, label: string, extra: Partial<Extract<VscodeMenuItem, { type: 'item' }>> = {}): VscodeMenuItem => ({ type: 'item', id, label, ...extra })
const ITEMS: VscodeMenuItem[] = [
  row('file', 'File', { submenu: [row('new', 'New Workspace'), row('settings', 'Settings…')] }),
  row('view', 'View', { submenu: [row('layout', 'Toggle Tab Layout'), row('output', 'Output'), row('clear', 'Clear Output')] }),
  row('help', 'Help', { submenu: [row('shortcuts', 'Keyboard Shortcuts Reference'), row('setup', 'Set up webterm…')] }),
]

/** Panel box and row boxes the layout would give: panels stack their rows 24px apart, starting at the panel top. */
let panelBox = { left: 60, right: 260 }
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'menu') return { ...panelBox, top: 50, bottom: 200, width: panelBox.right - panelBox.left, height: 150, x: panelBox.left, y: 50, toJSON: () => ({}) }
    const index = Number(this.getAttribute('data-index') ?? 0)
    const top = 50 + index * 24
    return { left: panelBox.left + 4, right: panelBox.right - 4, top, bottom: top + 24, width: 192, height: 24, x: panelBox.left + 4, y: top, toJSON: () => ({}) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); panelBox = { left: 60, right: 260 } })

const open = (onClose = vi.fn()) => { render(<VscodeMenu open anchor={{ x: 60, y: 50 }} items={ITEMS} onClose={onClose} ariaLabel="Menu" minWidth={200} />); return onClose }
const submenus = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-level="1"]')]
const labels = (menu: HTMLElement): string[] => [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? '')

describe('exclusivity: opening a submenu closes the previous one', () => {
  it('click View, then click Help: exactly one submenu is open and it is Help\'s', () => {
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    expect(submenus()).toHaveLength(1)
    expect(labels(submenus()[0])).toEqual(['Toggle Tab Layout', 'Output', 'Clear Output'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    expect(submenus()).toHaveLength(1)
    expect(labels(submenus()[0])).toEqual(['Keyboard Shortcuts Reference', 'Set up webterm…'])
    expect(screen.queryByRole('menuitem', { name: 'Output' })).toBeNull()
  })

  it('hovering across the parent rows moves the single open submenu; hovering a plain row closes it', () => {
    open()
    for (const name of ['File', 'View', 'Help', 'File']) {
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name }))
      expect(submenus()).toHaveLength(1)
    }
    expect(labels(submenus()[0])).toEqual(['New Workspace', 'Settings…'])
  })

  it('aria-haspopup / aria-expanded follow the one open parent', () => {
    open()
    const rows = ['File', 'View', 'Help'].map((name) => screen.getByRole('menuitem', { name }))
    expect(rows.map((r) => r.getAttribute('aria-haspopup'))).toEqual(['menu', 'menu', 'menu'])
    fireEvent.click(rows[1])
    expect(rows.map((r) => r.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false'])
    fireEvent.click(rows[2])
    expect(rows.map((r) => r.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'true'])
  })
})

describe('placement beside the parent', () => {
  it('the submenu is on the RIGHT of the parent panel with its first row level with the parent row (data-side + coordinates)', () => {
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' })) // second row: top 74
    const sub = submenus()[0]
    expect(sub.getAttribute('data-side')).toBe('right')
    expect(sub.style.left).toBe('256px') // parent panel right (260) - 4px overlap
    expect(sub.style.top).toBe('70px') // parent row top (74) - 4px
  })

  it('flips to the LEFT of the parent panel when the right edge does not fit the viewport', () => {
    panelBox = { left: 700, right: 900 } // jsdom viewport is 1024px wide: 896 + 200 > 1016
    render(<VscodeMenu open anchor={{ x: 700, y: 50 }} items={ITEMS} onClose={vi.fn()} ariaLabel="Menu" minWidth={200} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    const sub = submenus()[0]
    expect(sub.getAttribute('data-side')).toBe('left')
    expect(sub.style.left).toBe('504px') // parent panel left (700) + 4 - width (200)
  })

  it('sits above the side bar and canvas: the menu layer z-index is 1000', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/client/components/vscode/vscode-menu.css', 'utf8')
    expect(css).toMatch(/\.vscode-menu \{[^}]*position: fixed;[^}]*z-index: 1000/)
  })
})

describe('keyboard (WAI-ARIA menu)', () => {
  it('opens on focus of the first row; ArrowRight enters the submenu, ArrowLeft returns to the parent row and closes it', () => {
    open()
    expect((document.activeElement as HTMLElement).textContent).toBe('File')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect((document.activeElement as HTMLElement).textContent).toBe('View')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(submenus()).toHaveLength(1)
    expect((document.activeElement as HTMLElement).textContent).toBe('Toggle Tab Layout')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect((document.activeElement as HTMLElement).textContent).toBe('Output')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(submenus()).toHaveLength(0)
    expect((document.activeElement as HTMLElement).textContent).toBe('View')
  })

  it('ArrowDown from View onto Help while View is open closes View\'s submenu (focus moved off its parent row)', () => {
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(submenus()).toHaveLength(0)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(labels(submenus()[0])).toEqual(['Keyboard Shortcuts Reference', 'Set up webterm…'])
  })

  it('Escape closes one level at a time: the submenu first, then the menu', () => {
    const onClose = open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(submenus()).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('type-ahead jumps to the row that starts with the typed text', () => {
    open()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'h' })
    expect((document.activeElement as HTMLElement).textContent).toBe('Help')
  })

  it('activating a leaf row runs it and closes the whole tree', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<VscodeMenu open anchor={{ x: 0, y: 0 }} onClose={onClose} items={[row('a', 'A', { submenu: [row('leaf', 'Leaf', { onSelect })] })]} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'A' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leaf' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })
})
