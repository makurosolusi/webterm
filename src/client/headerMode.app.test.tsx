/** @vitest-environment jsdom */
// The real App in each header mode: the shell class that drives `--tabbar-h`, what the header
// draws, Full while booting, Hidden -> Compact without a pointer, and the one-time notice.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, mountHeld, unmountCanvas } from './canvasHarness'
import { HEADER_MODE_KEY, reloadHeaderModeFromStorage, setHeaderMode, type HeaderMode } from './headerMode.store'
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

describe('header mode in the real App', () => {
  it.each([['full', null], ['compact', 'app-shell--header-compact'], ['hidden', 'app-shell--header-hidden']] as const)(
    'stored %s puts %s on the shell once the board is up', async (mode, cls) => {
      setHeaderMode(mode)
      await mountCanvas(FIXTURE)
      if (cls) expect(shell().classList.contains(cls)).toBe(true)
      else expect(shell().className).not.toContain('app-shell--header-')
      expect(Boolean(document.querySelector('.app-titlebar'))).toBe(mode !== 'compact')
      // the app menu is a rail button in Compact/Hidden (Full: the header's menu bar)
      expect(Boolean(document.querySelector('.dock > .app-menu-button'))).toBe(mode !== 'full')
      expect(Boolean(document.querySelector('.app-titlebar [role="menubar"]'))).toBe(mode === 'full')
      expect(Boolean(document.querySelector('.app-tabs'))).toBe(mode !== 'hidden')
      // tiles live in the rail in Compact/Hidden, never in Full (one surface per control)
      expect(Boolean(document.querySelector('.dock [role="tablist"][aria-label="Workspaces"]'))).toBe(mode !== 'full')
    },
  )

  it('is Full while booting, whatever is stored (the header is the only door before the board is known)', async () => {
    setHeaderMode('hidden')
    const release = mountHeld(FIXTURE)
    expect(shell().className).not.toContain('app-shell--header-')
    expect(document.querySelector('.app-titlebar')).toBeTruthy()
    await release()
    await waitFor(() => expect(shell().classList.contains('app-shell--header-hidden')).toBe(true))
  })

  it('Hidden is drawn Compact on a device without hover', async () => {
    setHeaderMode('hidden')
    const mm = vi.fn((media: string) => ({ media, matches: media === '(hover: none)', addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }))
    vi.stubGlobal('matchMedia', mm)
    await mountCanvas(FIXTURE)
    expect(shell().classList.contains('app-shell--header-compact')).toBe(true)
    expect(shell().classList.contains('app-shell--header-hidden')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('Hidden puts a Search button at the top of the rail; the other modes do not', async () => {
    setHeaderMode('hidden')
    await mountCanvas(FIXTURE)
    const rail = document.querySelector('.dock') as HTMLElement
    expect(rail.querySelector('button[aria-label="Search"]')).toBeTruthy()
    unmountCanvas()
    setHeaderMode('compact')
    await mountCanvas(FIXTURE)
    expect((document.querySelector('.dock') as HTMLElement).querySelector('button[aria-label="Search"]')).toBeNull()
  })
})

describe('first-boot notice', () => {
  it('shows once when nobody chose a mode, restores Full on its action, and never returns', async () => {
    await mountCanvas(FIXTURE)
    await waitFor(() => expect(noticeShown()).toBe(true))
    expect(shell().classList.contains('app-shell--header-compact')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: HEADER_NOTICE_TEXT.restore }))
    await waitFor(() => expect(shell().className).not.toContain('app-shell--header-'))
    expect(noticeShown()).toBe(false)
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBe('full')
    // a later boot on this device (even back on Compact) stays quiet
    unmountCanvas()
    setHeaderMode('compact')
    await mountCanvas(FIXTURE)
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    expect(noticeShown()).toBe(false)
  })

  it.each(['full', 'hidden'] as const satisfies readonly HeaderMode[])('is not shown when the mode was chosen (%s)', async (mode) => {
    setHeaderMode(mode)
    await mountCanvas(FIXTURE)
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    expect(noticeShown()).toBe(false)
  })
})
