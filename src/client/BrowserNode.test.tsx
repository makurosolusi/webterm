/** @vitest-environment jsdom */
// Node browser: perilaku permukaan (kelas React Flow, wheel, keyboard, IME, paste, resize, frame+ack).
// Klien WS dipalsukan; tidak ada Chromium/server. Uji visual/zoom nyata butuh manusia.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ClientMsg, ServerMsg } from '../shared/browser.contract'
import type { BrowserListener } from './browser.stream'

const fake = vi.hoisted(() => {
  const state = { listener: null as null | BrowserListener, sent: [] as unknown[], calls: [] as string[] }
  return {
    state,
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => { state.calls.push('detach') } },
      attach: (_id: string, vp: unknown) => { state.calls.push('attach'); state.sent.push({ t: 'attach', ...(vp as object) }) },
      resize: (_id: string, vp: unknown) => { state.calls.push('resize'); state.sent.push({ t: 'resize', ...(vp as object) }) },
      detach: () => { state.calls.push('detach') },
      send: (m: ClientMsg) => { state.calls.push(m.t); state.sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: fake.stream }))

import BrowserNode from './BrowserNode'

type RoCb = (e: Array<{ contentRect: { width: number; height: number } }>) => void
let roCbs: RoCb[] = []
class FakeRO {
  constructor(cb: RoCb) { roCbs.push(cb) }
  observe() {}
  disconnect() {}
}
const resizeTo = (w: number, h: number) => act(() => { for (const cb of roCbs) cb([{ contentRect: { width: w, height: h } }]) })
const sentOf = (t: string) => fake.state.sent.filter((m) => (m as { t: string }).t === t)

const wheelOpts: unknown[] = []
const drawn: string[] = []
const mount = () => {
  const r = render(
    <ReactFlowProvider>
      <BrowserNode {...({ id: 'b1', data: { title: 't' }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} />
    </ReactFlowProvider>,
  )
  const surface = r.container.querySelector('.browser-surface') as HTMLElement
  const ime = r.container.querySelector('textarea') as HTMLTextAreaElement
  return { ...r, surface, ime }
}
const serverMsg = (m: ServerMsg) => act(() => fake.state.listener?.onMsg(m))

beforeEach(() => {
  fake.state.listener = null; fake.state.sent = []; fake.state.calls = []; roCbs = []; wheelOpts.length = 0; drawn.length = 0
  vi.stubGlobal('ResizeObserver', FakeRO)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: () => { drawn.push('close') } })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: () => { drawn.push('draw') } })) as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  const orig = HTMLElement.prototype.addEventListener
  vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type: string, l: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) {
    if (type === 'wheel') wheelOpts.push(o)
    return orig.call(this, type, l, o)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('BrowserNode', () => {
  it('permukaan memakai nodrag nowheel nokey dan fokusable', () => {
    const { surface } = mount()
    for (const c of ['nodrag', 'nowheel', 'nokey']) expect(surface.classList.contains(c)).toBe(true)
    expect(surface.tabIndex).toBe(0)
  })

  it('wheel non-passive dengan preventDefault; Ctrl+wheel tidak diteruskan', () => {
    const { surface } = mount()
    resizeTo(800, 600)
    expect(wheelOpts).toContainEqual({ passive: false })
    const plain = new WheelEvent('wheel', { deltaY: 50, clientX: 10, clientY: 10, cancelable: true, bubbles: true })
    surface.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(true)
    expect(sentOf('mouse')).toHaveLength(1)
    const ctrl = new WheelEvent('wheel', { deltaY: 50, ctrlKey: true, cancelable: true, bubbles: true })
    surface.dispatchEvent(ctrl)
    expect(ctrl.defaultPrevented).toBe(true) // tetap ditahan agar canvas tidak ikut zoom
    expect(sentOf('mouse')).toHaveLength(1)
  })

  it('keydown Tab dan Space di-preventDefault dan diteruskan', () => {
    const { surface } = mount()
    resizeTo(800, 600)
    expect(fireEvent.keyDown(surface, { key: 'Tab', code: 'Tab', keyCode: 9 })).toBe(false)
    expect(fireEvent.keyDown(surface, { key: ' ', code: 'Space', keyCode: 32 })).toBe(false)
    expect(sentOf('key').map((m) => (m as { code: string }).code)).toEqual(['Tab', 'Space'])
  })

  it('ResizeObserver: ukuran pertama attach; rentetan perubahan menghasilkan satu resize', () => {
    vi.useFakeTimers()
    mount()
    resizeTo(800, 600)
    expect(sentOf('attach')).toHaveLength(1)
    resizeTo(810, 600); resizeTo(820, 610); resizeTo(830, 620)
    expect(sentOf('resize')).toHaveLength(0)
    act(() => { vi.advanceTimersByTime(150) })
    expect(sentOf('resize')).toEqual([{ t: 'resize', w: 830, h: 620, dpr: 1 }])
  })

  it('compositionend mengirim text; compositionupdate mengirim ime', () => {
    const { ime } = mount()
    fireEvent.compositionUpdate(ime, { data: 'に' })
    fireEvent.compositionEnd(ime, { data: '日本' })
    expect(sentOf('ime')[0]).toMatchObject({ text: 'に' })
    expect(sentOf('text')).toEqual([{ t: 'text', id: 'b1', text: '日本' }])
  })

  it('paste mengirim text tanpa Clipboard API', () => {
    expect(navigator.clipboard).toBeUndefined()
    const { ime } = mount()
    fireEvent.paste(ime, { clipboardData: { getData: (k: string) => (k === 'text/plain' ? 'halo' : '') } })
    expect(sentOf('text')).toEqual([{ t: 'text', id: 'b1', text: 'halo' }])
  })

  it('frame digambar lebih dulu, baru ack dikirim', async () => {
    mount()
    resizeTo(800, 600)
    await act(async () => { fake.state.listener?.onFrame(9, new Uint8Array([1, 2])) })
    expect(drawn).toEqual(['draw', 'close'])
    expect(sentOf('ack')).toEqual([{ t: 'ack', id: 'b1', seq: 9 }])
    expect(fake.state.calls.indexOf('ack')).toBeGreaterThan(fake.state.calls.indexOf('attach'))
  })

  it('tanpa console.log, teks halaman asing hanya teks (tanpa HTML), kursor tak aman ditolak', () => {
    const log = vi.spyOn(console, 'log')
    const { container, surface } = mount()
    resizeTo(800, 600)
    serverMsg({ t: 'state', id: 'b1', url: 'https://user:pw@evil.test/p?token=abc', title: '<img src=x onerror=alert(1)>', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
    serverMsg({ t: 'cursor', id: 'b1', css: 'url(https://evil.test/x.png)' })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('token=abc')
    expect(container.textContent).not.toContain('pw@')
    expect((surface.querySelector('canvas') as HTMLElement).style.cursor).toBe('default')
    expect(log).not.toHaveBeenCalled()
  })

  it('unmount: detach dan listener wheel dilepas', () => {
    const { surface, unmount } = mount()
    resizeTo(800, 600)
    const remove = vi.spyOn(surface, 'removeEventListener')
    unmount()
    expect(fake.state.calls).toContain('detach')
    expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function))
  })
})
