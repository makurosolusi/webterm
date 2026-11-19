/** @vitest-environment jsdom */
// The hamburger: one button, File / View / Help as a cascade drawn by `VscodeMenu` (so one submenu at a time, beside
// its parent), focus returns to the button, a lone Alt press focuses it, and a press on the open button closes it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { AppMenuButton } from './AppMenuButton'
import type { VscodeMenu } from './components/vscode/vscodeMenu.model'

afterEach(cleanup)

const onSettings = vi.fn()
const MENUS: VscodeMenu[] = [
  { id: 'file', label: 'File', items: [{ id: 'new', label: 'New Workspace' }, { type: 'separator' }, { id: 'settings', label: 'Settings…', onSelect: onSettings }] },
  { id: 'view', label: 'View', items: [{ id: 'layout', label: 'Toggle Tab Layout' }, { id: 'rl', label: 'Show Rail Labels', checked: true }, { id: 'hd', label: 'Header', submenu: [{ id: 't', label: 'Tabs', checked: true }, { id: 'h', label: 'Hidden', checked: false }] }] },
  { id: 'help', label: 'Help', items: [{ id: 'k', label: 'Keyboard Shortcuts Reference' }] },
]
const button = (): HTMLElement => screen.getByRole('button', { name: 'Menu' })
const level = (n: number): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[role="menu"][data-level="${n}"]`)]

describe('AppMenuButton', () => {
  it('is one button with menu semantics, collapsed until pressed', () => {
    render(<AppMenuButton menus={MENUS} />)
    expect(button().getAttribute('aria-haspopup')).toBe('menu')
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(level(0)).toHaveLength(0)
  })

  it('opens File, View and Help as rows; File, then View, then Help leaves exactly one submenu open', () => {
    render(<AppMenuButton menus={MENUS} />)
    fireEvent.click(button())
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['File', 'View', 'Help'])
    for (const name of ['File', 'View', 'Help']) {
      fireEvent.click(screen.getByRole('menuitem', { name }))
      expect(level(1)).toHaveLength(1)
    }
    expect(screen.getByRole('menuitem', { name: /Keyboard Shortcuts/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Toggle Tab Layout' })).toBeNull()
  })

  it('renders nested submenus (View > Header) and checked rows from the same model', () => {
    render(<AppMenuButton menus={MENUS} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    expect(screen.getByRole('menuitemcheckbox', { name: /Show Rail Labels/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Header' }))
    expect(level(2)).toHaveLength(1)
    expect(level(1)).toHaveLength(1)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Tabs' }).getAttribute('aria-checked')).toBe('true')
  })

  it('running a row calls its handler, closes the whole menu and puts focus back on the button', () => {
    render(<AppMenuButton menus={MENUS} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }))
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(level(0)).toHaveLength(0)
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button())
  })

  it('Escape closes one level, then the menu, and focus returns to the button', () => {
    render(<AppMenuButton menus={MENUS} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(level(1)).toHaveLength(0)
    expect(level(0)).toHaveLength(1)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(level(0)).toHaveLength(0)
    expect(document.activeElement).toBe(button())
  })

  it('ArrowDown on the button opens the menu with focus on its first row', () => {
    render(<AppMenuButton menus={MENUS} />)
    button().focus()
    fireEvent.keyDown(button(), { key: 'ArrowDown' })
    expect(level(0)).toHaveLength(1)
    expect((document.activeElement as HTMLElement).textContent).toBe('File')
  })

  it('a press on the open button closes it and the click that follows does not reopen it', () => {
    render(<AppMenuButton menus={MENUS} />)
    fireEvent.click(button())
    fireEvent.pointerDown(button())
    fireEvent.click(button())
    expect(level(0)).toHaveLength(0)
    fireEvent.click(button()) // a later click opens it again
    expect(level(0)).toHaveLength(1)
  })

  it('a lone Alt press focuses the button; Alt with another key, or while typing, does not', () => {
    render(<><input aria-label="field" /><AppMenuButton menus={MENUS} /></>)
    fireEvent.keyDown(document.body, { key: 'Alt' })
    fireEvent.keyUp(document.body, { key: 'Alt' })
    expect(document.activeElement).toBe(button())
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Alt' })
    fireEvent.keyDown(document.body, { key: 'k' })
    fireEvent.keyUp(document.body, { key: 'Alt' })
    expect(document.activeElement).not.toBe(button())
    const field = screen.getByLabelText('field')
    field.focus()
    fireEvent.keyDown(field, { key: 'Alt' })
    fireEvent.keyUp(field, { key: 'Alt' })
    expect(document.activeElement).toBe(field)
  })

  it('the rail variant opens its first panel to the RIGHT of the button, the bar variant BELOW it', () => {
    const rect = (r: Partial<DOMRect>): void => { vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...r }) }
    rect({ left: 0, right: 48, top: 100, bottom: 148 })
    const rail = render(<AppMenuButton menus={MENUS} variant="rail" />)
    fireEvent.click(button())
    expect(level(0)[0].style.left).toBe('52px') // button right (48) + 4px gap
    expect(level(0)[0].style.top).toBe('100px')
    rail.unmount()
    rect({ left: 10, right: 45, top: 0, bottom: 35 })
    render(<AppMenuButton menus={MENUS} variant="bar" />)
    fireEvent.click(button())
    expect(level(0)[0].style.left).toBe('10px')
    expect(level(0)[0].style.top).toBe('39px') // button bottom (35) + 4px gap
    vi.restoreAllMocks()
  })
})
