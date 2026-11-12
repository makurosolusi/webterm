/** @vitest-environment jsdom */
// Node browser: halaman awal muncul saat URL kosong, hilang saat ada URL; pintasan mengirim nav; zoom menjepit.
// Klien WS dipalsukan; tampilan visual nyata (CSS) tidak terverifikasi di jsdom.
import type { ComponentProps, ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState, ClientMsg } from '../shared/browser.contract'
import type { BrowserListener } from './browser.stream'

const fake = vi.hoisted(() => {
  const st = { listener: null as null | BrowserListener, sent: [] as unknown[] }
  return {
    st,
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { st.listener = l; return () => undefined },
      attach: () => undefined, resize: () => undefined, detach: () => undefined,
      send: (m: ClientMsg) => { st.sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: fake.stream, getBrowserWorkspace: () => 'w' }))

import BrowserNode from './BrowserNode'
import { BrowserNodeType } from './BrowserNode.slots'
import { RECENT_STORAGE_KEY } from './browser.recent'
import { CHIP_TEXT, START_TEXT, TOOLBAR_MENU_TEXT, TOOLBAR_TEXT, ZOOM_TEXT } from './browser.uxText'
import { isMacPlatform } from './terminalKeys'

const state = (o: Partial<BrowserState> = {}): { t: 'state' } & BrowserState =>
  ({ t: 'state', id: 'b1', url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...o })
const push = (o: Partial<BrowserState>) => act(() => fake.st.listener?.onMsg(state(o)))
const mount = (data: Record<string, unknown> = {}, Comp: ComponentType<ComponentProps<typeof BrowserNode>> = BrowserNode) => render(
  <ReactFlowProvider>
    <Comp {...({ id: 'b1', data, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} />
  </ReactFlowProvider>,
)
const startPage = () => screen.queryByRole('region', { name: START_TEXT.page })

beforeEach(() => { fake.st.listener = null; fake.st.sent = []; localStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BrowserNode start page', () => {
  it('shows for a blank session and goes away once the page has a url', () => {
    mount()
    expect(startPage()).not.toBeNull()
    push({ url: 'about:blank' })
    expect(startPage()).not.toBeNull()
    push({ url: 'https://a.com/', loading: true })
    expect(startPage()).toBeNull()
  })

  it('stays hidden while a saved url is waiting to be loaded, and when navigation is blocked', () => {
    mount({ url: 'https://saved.com/' })
    expect(startPage()).toBeNull()
    cleanup()
    mount()
    push({ url: 'about:blank', blocked: 'scheme' })
    expect(startPage()).toBeNull()
  })

  it('sends nav go with the normalized url from the search box and from a shortcut', () => {
    mount()
    const box = screen.getByLabelText(START_TEXT.searchLabel)
    fireEvent.change(box, { target: { value: 'example.com' } })
    fireEvent.submit(box.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: START_TEXT.open('Wikipedia') }))
    expect(fake.st.sent.filter((m) => (m as { t: string }).t === 'nav')).toEqual([
      { t: 'nav', id: 'b1', action: 'go', url: 'https://example.com/' },
      { t: 'nav', id: 'b1', action: 'go', url: 'https://www.wikipedia.org/' },
    ])
  })

  it('records loaded real pages (origin+path only) but not blank or loading ones', () => {
    mount()
    push({ url: 'https://a.com/p?secret=1', title: 'A', loading: true })
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull()
    push({ url: 'https://a.com/p?secret=1', title: 'A', loading: false })
    const saved = localStorage.getItem(RECENT_STORAGE_KEY) ?? ''
    expect(saved).toContain('https://a.com/p')
    expect(saved).not.toContain('secret')
  })
})

describe('BrowserNode zoom', () => {
  it('zooms from the ⋯ menu, shows the pill, scales the surface wrapper and resets to 100%', () => {
    const { container } = mount({}, BrowserNodeType)
    const wrap = container.querySelector('.browser-zoom') as HTMLElement
    const menu = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.more }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    expect(screen.queryByRole('button', { name: ZOOM_TEXT.pill('100%') })).toBeNull()
    menu(ZOOM_TEXT.in)
    expect(screen.getByRole('button', { name: ZOOM_TEXT.pill('110%') }).textContent).toBe('110%')
    expect(wrap.style.getPropertyValue('--browser-zoom')).toBe('1.1')
    // Clamping at ZOOM_MIN/ZOOM_MAX is pinned by stepZoom's unit test (browser.startpage.test.ts); here only the wiring.
    menu(ZOOM_TEXT.out); menu(ZOOM_TEXT.out)
    expect(wrap.style.getPropertyValue('--browser-zoom')).toBe('0.9')
    menu(TOOLBAR_MENU_TEXT.zoomReset('90%'))
    expect(screen.queryByRole('button', { name: /^Zoom \d+%/ })).toBeNull()
    expect(wrap.style.getPropertyValue('--browser-zoom')).toBe('1')
  }, 15_000) // full node + 4 portal menus: ~2s alone, >5s under the parallel full suite
})

describe('BrowserNode toolbar seams (slots wiring)', () => {
  const chord = (code: string) => ({ code, key: code, ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }) })

  it('⌘L focuses the real omnibox; ⌘= shows the pill and the ⋯ reset row agrees; ⌘0 hides it', () => {
    const { container } = mount({}, BrowserNodeType)
    push({ url: 'https://a.com/' })
    const surface = container.querySelector('.browser-surface') as HTMLElement
    const omnibox = screen.getByLabelText(TOOLBAR_TEXT.urlLabel) as HTMLInputElement
    fireEvent.keyDown(surface, chord('KeyL'))
    expect(document.activeElement).toBe(omnibox)
    fireEvent.keyDown(surface, chord('Equal'))
    expect(screen.getByRole('button', { name: ZOOM_TEXT.pill('110%') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.more }))
    expect(screen.getByRole('menuitem', { name: TOOLBAR_MENU_TEXT.zoomReset('110%') })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.keyDown(surface, chord('Digit0'))
    expect(screen.queryByRole('button', { name: /^Zoom \d+%/ })).toBeNull()
    expect((container.querySelector('.browser-zoom') as HTMLElement).style.getPropertyValue('--browser-zoom')).toBe('1')
  })

  it('typing in the start-page box focuses the real omnibox and carries the text (one address input)', () => {
    mount({}, BrowserNodeType)
    const omnibox = screen.getByLabelText(TOOLBAR_TEXT.urlLabel) as HTMLInputElement
    const fakebox = screen.getByLabelText(START_TEXT.searchLabel) as HTMLInputElement
    fireEvent.change(fakebox, { target: { value: 'example.com' } })
    expect(document.activeElement).toBe(omnibox)
    expect(omnibox.value).toBe('example.com')
    expect(fakebox.value).toBe('')
    fireEvent.submit(omnibox.closest('form')!)
    expect(fake.st.sent.filter((m) => (m as { t: string }).t === 'nav')).toEqual([{ t: 'nav', id: 'b1', action: 'go', url: 'https://example.com/' }])
  })

  it('net-error plate covers the stream but not the toolbar; the lease chip stays above it', () => {
    const { container } = mount({}, BrowserNodeType)
    push({ url: 'http://nonexistent.invalid/', netError: 'net::ERR_NAME_NOT_RESOLVED', lease: 'agent' })
    const plate = screen.getAllByRole('alert').find((el) => el.textContent?.includes("can't be reached"))!
    expect(plate.closest('.browser-body')).not.toBeNull()
    expect(container.querySelector('.browser-body')!.contains(screen.getByRole('toolbar', { name: TOOLBAR_TEXT.group }))).toBe(false)
    const chip = screen.getByText(`${CHIP_TEXT.driving} ·`).closest('[role="status"]') as HTMLElement
    expect(chip.className).toContain('z-20')
    expect(plate.className).toContain('z-10')
  })
})
