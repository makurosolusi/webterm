/** @vitest-environment jsdom */
// BrowserNode browser-level shortcuts (browser.keys.ts), Ctrl+wheel zoom, saved zoom, and the agent-driven frame.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider, useNodes } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ClientMsg, ServerMsg } from '../shared/browser.contract'
import type { BrowserListener } from './browser.stream'

const fake = vi.hoisted(() => {
  const state = { listener: null as null | BrowserListener, sent: [] as unknown[] }
  return {
    state,
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => undefined },
      attach: () => undefined, resize: () => undefined, setAudio: () => undefined, detach: () => undefined,
      send: (m: ClientMsg) => { state.sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: fake.stream }))
vi.mock('./terminalKeys', async (orig) => ({ ...(await orig<object>()), isMacPlatform: () => true }))

import BrowserNode from './BrowserNode'
import BrowserLeaseChip from './BrowserLeaseChip'

type RoCb = (e: Array<{ contentRect: { width: number; height: number } }>) => void
let roCbs: RoCb[] = []
const sentOf = (t: string) => fake.state.sent.filter((m) => (m as { t: string }).t === t) as Array<Record<string, unknown>>
const serverMsg = (m: ServerMsg) => act(() => fake.state.listener?.onMsg(m))
const st = (o: Record<string, unknown> = {}) => serverMsg({ t: 'state', id: 'b1', url: 'https://a.test/', title: '', loading: false, canBack: true, canForward: true, lease: 'human', live: 'live', ...o } as ServerMsg)
const props = (data: Record<string, unknown>) => ({ id: 'b1', data, selected: false } as unknown as ComponentProps<typeof BrowserNode>)
const zoomOf = (c: HTMLElement) => (c.querySelector('.browser-zoom') as HTMLElement).style.getPropertyValue('--browser-zoom')

// Renders the node from the React Flow store, so writes to node data survive a remount (key change).
function Host({ remount }: { remount: number }) {
  const n = useNodes().find((x) => x.id === 'b1')
  return n ? <BrowserNode key={remount} {...props(n.data)} renderOverlay={(ctx) => <BrowserLeaseChip lease={ctx.state?.lease} onTakeover={ctx.takeover} />} /> : null
}
const initial: Node[] = [{ id: 'b1', type: 'browser', position: { x: 0, y: 0 }, data: { title: 't' } }]
const mount = () => {
  const r = render(<ReactFlowProvider initialNodes={initial} defaultNodes={initial}><Host remount={0} /></ReactFlowProvider>)
  const remount = () => r.rerender(<ReactFlowProvider initialNodes={initial} defaultNodes={initial}><Host remount={1} /></ReactFlowProvider>)
  const surface = r.container.querySelector('.browser-surface') as HTMLElement
  return { ...r, surface, remount }
}

beforeEach(() => {
  fake.state.listener = null; fake.state.sent = []
  roCbs = []
  vi.stubGlobal('ResizeObserver', class { constructor(cb: RoCb) { roCbs.push(cb) } observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('BrowserNode browser shortcuts', () => {
  it('⌘R / ⇧⌘R / ⌘[ / ⌘] drive navigation and never reach the page', () => {
    const { surface } = mount()
    st()
    const press = (code: string, o: KeyboardEventInit = {}) => fireEvent.keyDown(surface, { code, key: code, metaKey: true, ...o })
    expect(press('KeyR')).toBe(false) // defaultPrevented: the app page itself does not reload
    press('KeyR', { shiftKey: true })
    press('BracketLeft')
    press('BracketRight')
    expect(sentOf('nav').map((m) => m.action)).toEqual(['reload', 'reload', 'back', 'forward'])
    expect(sentOf('key')).toEqual([])
    fireEvent.keyDown(surface, { code: 'KeyA', key: 'a' }) // ordinary typing still goes to the page
    expect(sentOf('key')).toHaveLength(1)
  })

  it('⌘L focuses and selects the address input', () => {
    const { container, surface } = mount()
    const input = document.createElement('input')
    input.setAttribute('data-browser-omnibox', '')
    input.value = 'https://a.test/'
    container.querySelector('.browser-node')!.prepend(input)
    fireEvent.keyDown(surface, { code: 'KeyL', key: 'l', metaKey: true })
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length])
    expect(sentOf('key')).toEqual([])
  })

  it('Esc stops only while loading; otherwise it goes to the page', () => {
    const { surface } = mount()
    st({ loading: false })
    fireEvent.keyDown(surface, { code: 'Escape', key: 'Escape' })
    expect(sentOf('nav')).toEqual([])
    expect(sentOf('key')).toHaveLength(1)
    st({ loading: true })
    fireEvent.keyDown(surface, { code: 'Escape', key: 'Escape' })
    expect(sentOf('nav').map((m) => m.action)).toEqual(['stop'])
    expect(sentOf('key')).toHaveLength(1)
  })

  it('⌘= / ⌘- / ⌘0 zoom the page, not forwarded; zoom is saved and restored across remount', () => {
    const { container, surface, remount } = mount()
    fireEvent.keyDown(surface, { code: 'Equal', key: '=', metaKey: true })
    fireEvent.keyDown(surface, { code: 'Equal', key: '=', metaKey: true })
    expect(zoomOf(container)).toBe('1.2')
    fireEvent.keyDown(surface, { code: 'Minus', key: '-', metaKey: true })
    expect(zoomOf(container)).toBe('1.1')
    expect(sentOf('key')).toEqual([])
    remount()
    expect(zoomOf(container)).toBe('1.1')
    fireEvent.keyDown(container.querySelector('.browser-surface')!, { code: 'Digit0', key: '0', metaKey: true })
    expect(zoomOf(container)).toBe('1')
    remount()
    expect(zoomOf(container)).toBe('1')
  })

  it('Ctrl+wheel (pinch) zooms by accumulated delta and is not forwarded; plain wheel still scrolls the page', () => {
    const { container, surface } = mount()
    const wheel = (deltaY: number, ctrlKey: boolean) => {
      const ev = new WheelEvent('wheel', { deltaY, ctrlKey, clientX: 10, clientY: 10, cancelable: true, bubbles: true })
      act(() => { surface.dispatchEvent(ev) })
      return ev
    }
    expect(wheel(-20, true).defaultPrevented).toBe(true)
    expect(zoomOf(container)).toBe('1') // small pinch delta: not a step yet
    wheel(-40, true)
    expect(zoomOf(container)).toBe('1.1')
    wheel(100, true)
    expect(zoomOf(container)).toBe('1')
    expect(sentOf('mouse')).toEqual([])
    act(() => { for (const cb of roCbs) cb([{ contentRect: { width: 800, height: 600 } }]) }) // viewport known: plain wheel maps to the page
    wheel(50, false)
    expect(sentOf('mouse')).toHaveLength(1)
  })
})

describe('BrowserNode agent driving', () => {
  it('tints the frame and shows "Agent is driving · Take control" only while the agent holds the lease', () => {
    const { container } = mount()
    const frame = () => container.querySelector('.term-node') as HTMLElement
    st({ lease: 'human' })
    expect(frame().classList.contains('browser-node--driven')).toBe(false)
    expect(container.textContent).not.toContain('Agent is driving')
    st({ lease: 'agent' })
    expect(frame().classList.contains('browser-node--driven')).toBe(true)
    expect(container.textContent).toContain('Agent is driving ·')
    fireEvent.click(screen.getByRole('button', { name: /take control/i }))
    expect(sentOf('takeover')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /take control/i }).textContent).toBe('Take control')
  })
})
