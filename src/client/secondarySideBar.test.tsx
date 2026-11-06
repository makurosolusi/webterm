/** @vitest-environment jsdom */
// Secondary side bar (Chat + Central on the right): toggle by title-bar button and ⌥⌘B/Ctrl+Alt+B,
// width resize + persist + reset, maximize, docked vs narrow overlay layout, migration and
// unavailable storage. jsdom has no layout: the canvas squeeze is pinned through the selector
// that sets the grid column (`--aux-w`), real geometry is checked in a browser.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SecondarySideBar, { SecondarySideBarToggle } from './App.secondarySideBar'
import { useCommandKeybindings } from './commandRegistry'
import { useAppCommands } from './commandRegistry.defaults'
import {
  LEGACY_CENTRAL_OPEN_KEY, LEGACY_CHAT_OPEN_KEY, SIDE_BAR_DEFAULT_WIDTH, SIDE_BAR_KEY, SIDE_BAR_MIN_WIDTH,
  SIDE_BAR_OVERLAY_BREAKPOINT, SIDE_BAR_WIDTH_KEY, reloadSideBarFromStorage, setSideBar, sideBarWidth, toggleSideBar,
} from './secondarySideBar.store'

const WIDE = 1600
const DOCKED = ".app-shell:has(> .vscode-secondary-side-bar:not([data-maximized='true']):not(.vscode-secondary-side-bar--overlay))"
const read = (name: string) => readFileSync(`${process.cwd()}/src/client/${name}`, 'utf8')
const noop = () => {}

function Shell() {
  useAppCommands({
    openOmnibox: noop, openQuickOpen: noop, openFindInFiles: noop, openShortcuts: noop, openSettings: noop,
    newTerminal: noop, newFiles: noop, fitView: noop, toggleMaximizeNode: noop, toggleSessions: noop,
    toggleInbox: noop, toggleChat: noop, toggleSecondarySideBar: toggleSideBar, toggleBoard: noop,
  })
  useCommandKeybindings()
  return (
    <div className="app-shell">
      <SecondarySideBarToggle />
      <div className="app-main"><div className="board-host" data-mode="canvas" /></div>
      <SecondarySideBar centralEnabled={false} />
    </div>
  )
}

const sideBar = () => document.querySelector('.vscode-secondary-side-bar')
const shell = () => document.querySelector('.app-shell')!
const sash = () => screen.getByRole('separator', { name: 'Resize side bar' })

beforeEach(() => {
  vi.stubGlobal('innerWidth', WIDE)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
  localStorage.clear()
  reloadSideBarFromStorage()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  reloadSideBarFromStorage()
  document.documentElement.style.removeProperty('--secondary-side-bar-w')
})

describe('toggle', () => {
  it('the title-bar button opens and hides the side bar and persists the choice', () => {
    render(<Shell />)
    const button = screen.getByRole('button', { name: 'Toggle Secondary Side Bar' })
    expect(sideBar()).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(sideBar()).not.toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem(SIDE_BAR_KEY)!)).toEqual({ open: true, view: 'chat' })
    fireEvent.click(button)
    expect(sideBar()).toBeNull()
  })

  it('Ctrl+Alt+B (⌥⌘B on macOS) toggles it through the command registry, even from a text field', () => {
    render(<Shell />)
    fireEvent.keyDown(document, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })
    expect(sideBar()).not.toBeNull()
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: '∫', code: 'KeyB', ctrlKey: true, altKey: true })
    expect(sideBar()).toBeNull()
    input.remove()
  })

  it('the close action hides it; tabs are not closable', () => {
    setSideBar({ open: true })
    render(<Shell />)
    expect(screen.queryByRole('button', { name: 'Close Chat' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide Secondary Side Bar' }))
    expect(sideBar()).toBeNull()
  })

  it('shows Chat while Central is selected but its flag is off', () => {
    setSideBar({ open: true, view: 'central' })
    render(<Shell />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat'])
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('width', () => {
  it('defaults to 380px and the sash resizes from the left edge, persisted, double-click resets', () => {
    setSideBar({ open: true })
    render(<Shell />)
    expect(sash().getAttribute('aria-valuenow')).toBe(String(SIDE_BAR_DEFAULT_WIDTH))
    expect(sash().getAttribute('aria-orientation')).toBe('vertical')
    fireEvent.keyDown(sash(), { key: 'ArrowLeft' })
    expect(sash().getAttribute('aria-valuenow')).toBe('390')
    fireEvent.pointerDown(sash(), { button: 0, clientX: 1000 })
    fireEvent.pointerMove(sash(), { clientX: 900 }) // dragged 100px towards the canvas
    fireEvent.pointerUp(sash())
    expect(sash().getAttribute('aria-valuenow')).toBe('490')
    expect(localStorage.getItem(SIDE_BAR_WIDTH_KEY)).toBe('490')
    expect(document.documentElement.style.getPropertyValue('--secondary-side-bar-w')).toBe('490px')
    act(() => { sideBarWidth.reload() })
    expect(sideBarWidth.current()).toBe(490)
    fireEvent.doubleClick(sash())
    expect(sash().getAttribute('aria-valuenow')).toBe(String(SIDE_BAR_DEFAULT_WIDTH))
    expect(localStorage.getItem(SIDE_BAR_WIDTH_KEY)).toBeNull()
  })

  it('clamps into [260px, 60% of the window]', () => {
    expect(sideBarWidth.clamp(10)).toBe(SIDE_BAR_MIN_WIDTH)
    expect(sideBarWidth.clamp(5000)).toBe(WIDE * 0.6)
    expect(sideBarWidth.afterKey('ArrowRight', true, 400)).toBe(350)
    expect(sideBarWidth.afterKey('End', false, 400)).toBe(WIDE * 0.6)
  })
})

describe('layout', () => {
  it('docked: the side bar takes the aux grid column, so the canvas column shrinks', () => {
    const styles = read('styles.css')
    expect(styles).toMatch(/grid-template-columns: var\(--activity-bar-w\) 0 minmax\(0, 1fr\) var\(--aux-w\);/)
    expect(styles).toContain("'activity sidebar main aux'")
    expect(read('secondarySideBar.css')).toContain(`${DOCKED} {\n  --aux-w: min(var(--secondary-side-bar-w), 60vw);`)
    render(<Shell />)
    expect(shell().matches(DOCKED)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Secondary Side Bar' }))
    expect(shell().matches(DOCKED)).toBe(true)
  })

  it('maximize widens it over the canvas area and restores', () => {
    setSideBar({ open: true })
    render(<Shell />)
    fireEvent.click(screen.getByRole('button', { name: 'Maximize Secondary Side Bar' }))
    expect(sideBar()!.getAttribute('data-maximized')).toBe('true')
    expect(shell().matches(DOCKED)).toBe(false) // overlay: the grid column goes back to 0
    fireEvent.click(screen.getByRole('button', { name: 'Restore Secondary Side Bar' }))
    expect(sideBar()!.getAttribute('data-maximized')).toBe('false')
    expect(shell().matches(DOCKED)).toBe(true)
  })

  it('below the breakpoint it overlays the canvas from the right, and docks again when the window widens', () => {
    setSideBar({ open: true })
    vi.stubGlobal('innerWidth', SIDE_BAR_OVERLAY_BREAKPOINT - 1)
    render(<Shell />)
    expect(sideBar()!.classList.contains('vscode-secondary-side-bar--overlay')).toBe(true)
    expect(shell().matches(DOCKED)).toBe(false)
    expect(screen.getByRole('button', { name: 'Hide Secondary Side Bar' })).toBeTruthy()
    act(() => {
      vi.stubGlobal('innerWidth', WIDE)
      window.dispatchEvent(new Event('resize'))
    })
    expect(sideBar()!.classList.contains('vscode-secondary-side-bar--overlay')).toBe(false)
    expect(shell().matches(DOCKED)).toBe(true)
  })
})

describe('persistence', () => {
  it('migrates an open bottom-panel Chat or Central once, and drops the old keys', () => {
    localStorage.clear()
    localStorage.setItem(LEGACY_CENTRAL_OPEN_KEY, '1')
    reloadSideBarFromStorage()
    expect(JSON.parse(localStorage.getItem(SIDE_BAR_KEY)!)).toEqual({ open: true, view: 'central' })
    expect(localStorage.getItem(LEGACY_CENTRAL_OPEN_KEY)).toBeNull()
    localStorage.clear()
    localStorage.setItem(LEGACY_CHAT_OPEN_KEY, '0')
    reloadSideBarFromStorage()
    expect(JSON.parse(localStorage.getItem(SIDE_BAR_KEY)!)).toEqual({ open: false, view: 'chat' })
    expect(localStorage.getItem(LEGACY_CHAT_OPEN_KEY)).toBeNull()
  })

  it('works for the session when storage is unavailable', () => {
    const boom = () => { throw new Error('denied') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    reloadSideBarFromStorage()
    render(<Shell />)
    expect(sideBar()).toBeNull() // starts closed
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Secondary Side Bar' }))
    expect(sideBar()).not.toBeNull()
    fireEvent.keyDown(sash(), { key: 'ArrowLeft' })
    expect(sash().getAttribute('aria-valuenow')).toBe('390')
    vi.restoreAllMocks()
  })
})
