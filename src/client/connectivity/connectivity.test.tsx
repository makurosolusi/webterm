/** @vitest-environment jsdom */
// Root-locking tests for the Claude-link status item: shown only when the SERVER says so, spoken once, never accusing.
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasStatusBar } from '../Dock.statusBar'
import type { DockProps } from '../Dock.types'
import { dispatchBroadcast, notifyReconnect } from '../ws.listeners'
import { ANNOUNCE_GAP_MS } from './ConnectivityLive'
import { buildView } from './connectivity.view'
import { DEGRADED_SHOW_MS, RECOVERED_SHOW_MS } from './useConnectivity'

const SINCE = Date.UTC(2026, 10, 16, 10, 3)
type Body = { state: 'online' | 'degraded' | 'offline'; since: number; cause?: string; scope?: string }
let fetchMock: ReturnType<typeof vi.fn>

const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const frame = (b: Body) => act(() => { dispatchBroadcast({ t: 'net', v: 1, ...b } as never) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

async function mount(initial: ReturnType<typeof reply>) {
  fetchMock.mockResolvedValue(initial)
  const ui = render(<CanvasStatusBar {...({ zoomPct: 100, onUndo() {}, onRedo() {}, onFit() {}, onZoomIn() {}, onZoomOut() {} } as unknown as DockProps)} />)
  await flush()
  return ui
}
const item = (c: HTMLElement) => c.querySelector('[data-slot="vscode-status-bar-left"] .vscode-status-bar__label')
const live = (c: HTMLElement) => c.querySelector('[data-slot="connectivity-live"]') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(SINCE + 60_000)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Claude link status item', () => {
  it('(a) offline shows once with scope wording; back online says so and dismisses itself', async () => {
    const { container } = await mount(reply(200, { state: 'online', since: SINCE }))
    expect(item(container)).toBeNull()
    await frame({ state: 'offline', since: SINCE, scope: 'network', cause: 'dns' })
    expect(container.querySelectorAll('[data-slot="vscode-status-bar-left"] [data-tone="error"]')).toHaveLength(1)
    expect(item(container)?.textContent).toMatch(/^Your network looks offline since .+ · work is paused, not failed$/)
    await frame({ state: 'offline', since: SINCE, scope: 'api' })
    expect(item(container)?.textContent).toMatch(/^Can't reach the Claude API or its proxy since /)
    await frame({ state: 'online', since: SINCE + 90_000 })
    expect(item(container)?.textContent).toBe('Back online')
    await advance(RECOVERED_SHOW_MS + 1)
    expect(item(container)).toBeNull()
  })

  it('(b) 503 and 403 are unknown: nothing is shown and nobody is accused', async () => {
    for (const status of [503, 403]) {
      const { container, unmount } = await mount(reply(status))
      expect(item(container)).toBeNull()
      expect(live(container).textContent).toBe('')
      unmount()
    }
  })

  it('(c) flapping: the item never blinks out and speech is rate limited', async () => {
    const { container } = await mount(reply(200, { state: 'online', since: SINCE }))
    const spoken: string[] = []
    new MutationObserver(() => spoken.push(live(container).textContent ?? '')).observe(live(container), { childList: true, characterData: true, subtree: true })
    for (let i = 0; i < 8; i++) {
      await frame({ state: i % 2 === 0 ? 'offline' : 'online', since: SINCE + i, scope: 'api' })
      expect(item(container)).not.toBeNull()
      await advance(200)
    }
    await advance(ANNOUNCE_GAP_MS * 2)
    // 8 flips over ~1.6 s: one immediate sentence plus at most one trailing one after the 3 s gap.
    expect(spoken.filter(Boolean).length).toBeGreaterThanOrEqual(1)
    expect(spoken.filter(Boolean).length).toBeLessThanOrEqual(2)
  })

  it('(c2) a degraded blip under the hysteresis is never shown', async () => {
    const { container } = await mount(reply(200, { state: 'online', since: SINCE }))
    await frame({ state: 'degraded', since: SINCE })
    await advance(DEGRADED_SHOW_MS - 1000)
    expect(item(container)).toBeNull()
    await frame({ state: 'online', since: SINCE })
    await advance(DEGRADED_SHOW_MS * 2)
    expect(item(container)).toBeNull()
  })

  it('(d) a WS reconnect re-reads the server state', async () => {
    const { container } = await mount(reply(200, { state: 'online', since: SINCE }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(reply(200, { state: 'offline', since: SINCE, scope: 'network' }))
    await act(async () => { notifyReconnect(); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(item(container)?.textContent).toMatch(/^Your network looks offline/)
  })

  it('(e) the live region is always mounted, polite and never assertive', async () => {
    const { container } = await mount(reply(503))
    expect(live(container)).not.toBeNull()
    await frame({ state: 'offline', since: SINCE, scope: 'api' })
    const region = live(container)
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.textContent).toMatch(/Work is paused, not failed/)
    expect(container.querySelector('[aria-live="assertive"], [role="alert"]')).toBeNull()
  })

  it('(f) tooltips carry no URL or host', () => {
    for (const kind of ['offline', 'degraded', 'recovered'] as const) {
      const v = buildView({ kind, net: { state: 'offline', since: SINCE, cause: 'tls', scope: 'api' } }, SINCE + 5 * 60_000)
      expect(v.tooltip + v.label + v.announce).not.toMatch(/https?:|:\/\/|api\.anthropic|\.com|localhost|\d+\.\d+\.\d+\.\d+/i)
    }
    const tip = buildView({ kind: 'offline', net: { state: 'offline', since: SINCE, cause: 'dns' } }, SINCE + 5 * 60_000).tooltip
    expect(tip).toMatch(/5 min/)
    expect(tip).toMatch(/name lookup failed/)
  })

  it('(g) nothing animates (reduced motion has nothing to disable)', async () => {
    const { container } = await mount(reply(200, { state: 'offline', since: SINCE, scope: 'api' }))
    const el = container.querySelector('[data-tone="error"]') as HTMLElement
    expect(el.outerHTML).not.toMatch(/animat|transition/i)
  })

  it('(h) every state renders: loading, unknown, online, degraded, offline, recovered', async () => {
    let resolve!: (v: unknown) => void
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(<CanvasStatusBar {...({ zoomPct: 100 } as unknown as DockProps)} />)
    expect(item(container)).toBeNull() // loading: nothing, no flicker
    await act(async () => { resolve(reply(200, { state: 'degraded', since: SINCE })); await vi.advanceTimersByTimeAsync(0) })
    expect(item(container)).toBeNull() // degraded, still inside the hysteresis
    await advance(DEGRADED_SHOW_MS + 1)
    expect(item(container)?.textContent).toBe('Connection to Claude is unstable')
    await frame({ state: 'offline', since: SINCE })
    expect(item(container)?.textContent).toMatch(/^Claude API unreachable since /)
    await frame({ state: 'online', since: SINCE })
    expect(item(container)?.textContent).toBe('Back online')
  })
})

describe('Claude link status item: keyboard access', () => {
  const focusViaKeyboard = (el: HTMLElement) => {
    fireEvent.keyDown(document.body, { key: 'Tab' })
    act(() => { el.focus() })
  }
  const connectivityItem = (c: HTMLElement) => c.querySelector('[data-slot="vscode-status-bar-left"] [data-slot="vscode-status-bar-item"]') as HTMLElement
  const tooltip = () => document.querySelector('[data-slot="tooltip-content"]')

  it('is reachable with Tab and opens its detailed tooltip on keyboard focus, described by it', async () => {
    const { container } = await mount(reply(200, { state: 'offline', since: SINCE, scope: 'api', cause: 'dns' }))
    const el = connectivityItem(container)
    expect(el.tabIndex).toBe(0)
    expect(el.getAttribute('aria-describedby')).toBeNull()
    focusViaKeyboard(el)
    await flush()
    expect(tooltip()?.textContent).toMatch(/name lookup failed/)
    expect(el.getAttribute('aria-describedby')).toBeTruthy()
  })

  it('does not open the tooltip for focus that did not come from the keyboard', async () => {
    const { container } = await mount(reply(200, { state: 'offline', since: SINCE, scope: 'api', cause: 'dns' }))
    const el = connectivityItem(container)
    fireEvent.pointerDown(el)
    act(() => { el.focus() })
    await flush()
    expect(tooltip()).toBeNull()
  })

  it('cuts a long label visually but keeps the full sentence in the aria-label and the live region whole', async () => {
    const { container } = await mount(reply(200, { state: 'offline', since: SINCE, scope: 'api' }))
    const el = connectivityItem(container)
    expect(el.getAttribute('data-truncate')).toBe('true')
    const full = el.querySelector('.vscode-status-bar__label')!.textContent!
    expect(full).toMatch(/^Can't reach the Claude API or its proxy since .+ · work is paused, not failed$/)
    expect(el.getAttribute('aria-label')).toBe(full)
    expect(live(container).textContent).toBe("Can't reach the Claude API or its proxy. Work is paused, not failed.")
    const css = readFileSync('src/client/components/vscode/vscode-shell.css', 'utf8') // vitest runs from the repo root
    expect(css).toMatch(/\[data-truncate='true'\] \.vscode-status-bar__label \{[^}]*text-overflow: ellipsis/)
  })
})
