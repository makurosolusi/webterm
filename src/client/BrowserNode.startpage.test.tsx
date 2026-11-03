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
import { START_TEXT, ZOOM_TEXT } from './browser.uxText'
import { ZOOM_MAX, ZOOM_MIN } from './browser.zoom'

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
  it('steps the toolbar zoom, scales the surface wrapper and clamps at the limits', () => {
    const { container } = mount({}, BrowserNodeType)
    const wrap = container.querySelector('.browser-zoom') as HTMLElement
    const level = () => screen.getByRole('group', { name: ZOOM_TEXT.level }).textContent
    expect(level()).toBe('100%')
    fireEvent.click(screen.getByRole('button', { name: ZOOM_TEXT.in }))
    expect(level()).toBe('110%')
    expect(wrap.style.getPropertyValue('--browser-zoom')).toBe('1.1')
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: ZOOM_TEXT.in }))
    expect(level()).toBe(`${ZOOM_MAX * 100}%`)
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole('button', { name: ZOOM_TEXT.out }))
    expect(level()).toBe(`${ZOOM_MIN * 100}%`)
  })
})
