/** @vitest-environment jsdom */
// The real App in each header mode: the shell class that drives `--tabbar-h`, what the header draws (a tab row and
// never a title bar), Tabs while booting, Hidden -> Tabs without a pointer, the rail's order, and the one-time notice
// for a stored Full / Compact value.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, mountHeld, unmountCanvas } from './canvasHarness'
import { HEADER_MODE_KEY, HEADER_NOTICE_KEY, reloadHeaderModeFromStorage, setHeaderMode } from './headerMode.store'
import { HEADER_NOTICE_CHANNEL, HEADER_NOTICE_TEXT } from './headerMode.notice'
import { closeNotice } from './workspaceSave.notice'

beforeAll(installCanvasDom)
beforeEach(() => {
  localStorage.clear()
  reloadHeaderModeFromStorage()
})
afterEach(() => {
  unmountCanvas()
  closeNotice(HEADER_NOTICE_CHANNEL)
  vi.restoreAllMocks()
})

const shell = (): HTMLElement => document.querySelector('.app-shell') as HTMLElement
const FIXTURE = { nodes: [], dirs: {} }
const noticeShown = (): boolean => screen.queryByText(HEADER_NOTICE_TEXT.title) !== null
const dockLabels = (): string[] => [...document.querySelectorAll('.dock button')].map((b) => b.getAttribute('aria-label') ?? '')

describe('header mode in the real App', () => {
  it.each([['tabs', null], ['hidden', 'app-shell--header-hidden']] as const)(
    'stored %s puts %s on the shell once the board is up', async (mode, cls) => {
      setHeaderMode(mode)
      await mountCanvas(FIXTURE)
      if (cls) expect(shell().classList.contains(cls)).toBe(true)
      else expect(shell().className).not.toContain('app-shell--header-')
      // never a title bar, brand or menu bar; the one header region is the tab row
      expect(document.querySelector('.app-titlebar, .brand, [role="menubar"]')).toBeNull()
      expect(document.querySelectorAll('[data-header-region]')).toHaveLength(1)
      expect(document.querySelector('.app-tabs [role="tablist"][aria-label="Workspaces"]')).toBeTruthy()
      // workspaces are tabs in the row, never tiles in the rail (one surface per control)
      expect(document.querySelector('.dock [role="tablist"], .dock [role="tab"]')).toBeNull()
      // the app menu is the first control of the rail
      expect((document.querySelector('.dock') as HTMLElement).querySelector('button')?.getAttribute('aria-label')).toBe('Menu')
    },
  )

  it('is Tabs while booting, whatever is stored (the row is the only door before the board is known)', async () => {
    setHeaderMode('hidden')
    const release = mountHeld(FIXTURE)
    expect(shell().className).not.toContain('app-shell--header-')
    expect(document.querySelector('.app-tabs')).toBeTruthy()
    expect(document.querySelector('.app-titlebar')).toBeNull()
    await release()
    await waitFor(() => expect(shell().classList.contains('app-shell--header-hidden')).toBe(true))
  })

  it('Hidden is drawn as Tabs on a device without hover', async () => {
    setHeaderMode('hidden')
    const mm = vi.fn((media: string) => ({ media, matches: media === '(hover: none)', addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }))
    vi.stubGlobal('matchMedia', mm)
    await mountCanvas(FIXTURE)
    expect(shell().className).not.toContain('app-shell--header-')
    vi.unstubAllGlobals()
  })

  it.each(['tabs', 'hidden'] as const)('%s: the rail runs menu, Search, tools, then Account / Settings / ... in that order', async (mode) => {
    setHeaderMode(mode)
    await mountCanvas(FIXTURE)
    const labels = dockLabels()
    expect(labels.slice(0, 2)).toEqual(['Menu', 'Search'])
    const at = (name: string): number => labels.indexOf(name)
    expect(at('Layers')).toBeGreaterThan(at('Search'))
    expect(at('Add node')).toBeGreaterThan(at('Layers'))
    expect(at('Settings')).toBeGreaterThan(at('Add node'))
    expect(at('Clean view')).toBeGreaterThan(at('Settings'))
    if (mode === 'hidden') expect(labels.indexOf('Toggle tab layout')).toBeGreaterThan(at('Settings'))
    else expect(labels).not.toContain('Toggle tab layout')
  })

  it('the layout switch is in the tab row in Tabs (and nowhere else), in the rail in Hidden', async () => {
    await mountCanvas(FIXTURE)
    expect(document.querySelector('.app-tabs button[aria-label="Toggle tab layout"]')).toBeTruthy()
    expect(document.querySelector('.dock button[aria-label="Toggle tab layout"]')).toBeNull()
    unmountCanvas()
    setHeaderMode('hidden')
    await mountCanvas(FIXTURE)
    expect(document.querySelector('.app-tabs button[aria-label="Toggle tab layout"]')).toBeNull()
    expect(document.querySelector('.dock button[aria-label="Toggle tab layout"]')).toBeTruthy()
  })
})

describe('notice for a carried-over value', () => {
  it.each(['full', 'compact'])('stored %s becomes Tabs, shows one informative notice, rewrites the stored value and never returns', async (legacy) => {
    localStorage.setItem(HEADER_MODE_KEY, legacy)
    reloadHeaderModeFromStorage()
    await mountCanvas(FIXTURE)
    await waitFor(() => expect(noticeShown()).toBe(true))
    expect(shell().className).not.toContain('app-shell--header-')
    expect(screen.queryAllByRole('button', { name: /restore/i })).toHaveLength(0) // informative, not alarming: no undo action
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBe('tabs')
    expect(localStorage.getItem(HEADER_NOTICE_KEY)).toBe('1')
    unmountCanvas()
    closeNotice(HEADER_NOTICE_CHANNEL)
    await mountCanvas(FIXTURE)
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    expect(noticeShown()).toBe(false)
  })

  it.each([null, 'tabs', 'hidden'])('is not shown when nothing changed (stored %s)', async (stored) => {
    if (stored) localStorage.setItem(HEADER_MODE_KEY, stored)
    reloadHeaderModeFromStorage()
    await mountCanvas(FIXTURE)
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    expect(noticeShown()).toBe(false)
  })

  it('the notice can be dismissed like any other', async () => {
    localStorage.setItem(HEADER_MODE_KEY, 'compact')
    reloadHeaderModeFromStorage()
    await mountCanvas(FIXTURE)
    await waitFor(() => expect(noticeShown()).toBe(true))
    const close = screen.queryByRole('button', { name: /dismiss|close/i })
    if (close) fireEvent.click(close)
  })
})
