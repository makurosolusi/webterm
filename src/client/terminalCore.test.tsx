/**
 * @vitest-environment jsdom
 */
// TerminalCore di canvas sungguhan: wheel, kapan `open` dikirim, dan dedupe `resize`.
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import type { WsNode } from '../shared/workspace'

const { sent } = vi.hoisted(() => ({ sent: [] as { t: string; id: string; cols?: number; rows?: number }[] }))
vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: (m: { t: string; id: string }) => { sent.push(m) } }
})
// Rekam instance xterm sungguhan (tanpa mengganti perilakunya) supaya test bisa membaca `options`.
const { terms } = vi.hoisted(() => ({ terms: [] as { options: { fontSize?: number }; refresh(a: number, b: number): void }[] }))
vi.mock('@xterm/xterm', async (importOriginal) => {
  const real = await importOriginal<typeof import('@xterm/xterm')>()
  class Recorded extends real.Terminal {
    constructor(...a: ConstructorParameters<typeof real.Terminal>) { super(...a); terms.push(this) }
  }
  return { ...real, Terminal: Recorded }
})
// Unique delay: the `open` fallback timer is recognised by it and fired by hand, never by the wall clock.
const { FALLBACK_MS } = vi.hoisted(() => ({ FALLBACK_MS: 987_654 }))
vi.mock('./terminalSizing', async (importOriginal) => {
  const real = await importOriginal<typeof import('./terminalSizing')>()
  return { ...real, OPEN_SIZE_FALLBACK_MS: FALLBACK_MS }
})

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

/** Ukuran host terminal (kelas `nowheel`); 0 = elemen tersembunyi/collapsed. */
let hostSize = 0
const OBSERVER_SETTLE_MS = 120

beforeAll(() => {
  installCanvasDom()
  for (const dim of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, dim, {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('nowheel') ? hostSize : 0 },
    })
  }
})
/** Held `open` fallback callbacks; they never run on their own, so nothing races the mount. */
let fallbackCbs: (() => void)[] = []
beforeEach(() => {
  fallbackCbs = []
  // Only the fallback timer is held: faking every setTimeout would also freeze React Flow's onInit
  // and testing-library's waitFor, so all other timers pass through to the real clock.
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (ms === FALLBACK_MS) { fallbackCbs.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }
    return realSetTimeout(fn, ms, ...a)
  }) as typeof setTimeout)
})
afterEach(() => {
  vi.restoreAllMocks()
  unmountCanvas()
  sent.length = 0
  terms.length = 0
  hostSize = 0
})

const ofType = (t: string) => sent.filter((m) => m.t === t)

describe('TerminalCore', () => {
  it('host terminal ber-kelas nowheel + nodrag, jadi scroll tidak mem-pan canvas', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    const host = document.querySelector('.react-flow__node-terminal .node-body .nowheel')
    expect(host).not.toBeNull()
    expect(host?.classList.contains('nodrag')).toBe(true)
  })

  it('elemen berukuran: `open` langsung terkirim sekali, resize tak pernah berulang untuk ukuran sama', async () => {
    hostSize = 400
    await mountCanvas({ nodes: [termNode], dirs: {} })

    await waitFor(() => expect(ofType('open')).toHaveLength(1))
    // Biarkan ResizeObserver + rAF menyala (jsdom mengukur grid lain dari 80x24, jadi satu resize sah).
    await new Promise((r) => setTimeout(r, OBSERVER_SETTLE_MS))
    expect(ofType('open')).toHaveLength(1)
    const sizes = ofType('resize').map((m) => `${m.cols}x${m.rows}`)
    expect(new Set(sizes).size).toBe(sizes.length)
    expect(sizes).not.toContain('80x24')
  })

  it('elemen 0x0: `open` ditunda, lalu terkirim lewat fallback batas waktu', async () => {
    hostSize = 0
    await mountCanvas({ nodes: [termNode], dirs: {} })
    expect(fallbackCbs).toHaveLength(1)
    // Let ResizeObserver + rAF fire: the host stays 0x0, so `open` must still be deferred.
    await new Promise((r) => setTimeout(r, OBSERVER_SETTLE_MS))
    expect(ofType('open')).toHaveLength(0)

    act(() => fallbackCbs[0]())
    expect(ofType('open')).toHaveLength(1)
    expect(ofType('open')[0]).toMatchObject({ id: 'term-1', cols: 80, rows: 24 })
  })

  it('no refit while the host is hidden (xterm renderer paused); refits once it is shown again', async () => {
    hostSize = 400
    // Fake IntersectionObserver per observed element + a ResizeObserver spy so the test can poke both.
    const ios: { target?: Element; cb: IntersectionObserverCallback }[] = []
    class FakeIO {
      private rec: { target?: Element; cb: IntersectionObserverCallback }
      constructor(cb: IntersectionObserverCallback) { this.rec = { cb }; ios.push(this.rec) }
      observe(el: Element) { this.rec.target = el }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO)
    const RealRO = globalThis.ResizeObserver
    const ros: { cb: ResizeObserverCallback; self: ResizeObserver }[] = []
    class SpyRO extends RealRO { constructor(cb: ResizeObserverCallback) { super(cb); ros.push({ cb, self: this }) } }
    vi.stubGlobal('ResizeObserver', SpyRO)
    try {
      await mountCanvas({ nodes: [termNode], dirs: {} })
      await waitFor(() => expect(ofType('open')).toHaveLength(1))
      await new Promise((r) => setTimeout(r, OBSERVER_SETTLE_MS))
      const ours = ios.find((o) => o.target?.classList.contains('nowheel'))!
      expect(ours).toBeDefined()
      const setVisible = (v: boolean) => ours.cb([{ isIntersecting: v } as IntersectionObserverEntry], {} as IntersectionObserver)
      const poke = () => ros.forEach((r) => r.cb([], r.self))
      // `refresh` runs right after `fit.fit()` in refit, so it counts refits regardless of whether the grid changed.
      const refresh = vi.spyOn(terms[0], 'refresh')

      setVisible(false)
      hostSize = 900 // ResizeObserver fires while the renderer is still paused: must not refit
      poke()
      await new Promise((r) => setTimeout(r, OBSERVER_SETTLE_MS))
      expect(refresh).not.toHaveBeenCalled()

      setVisible(true) // edge -> scheduled refit picks up the new size
      await waitFor(() => expect(refresh).toHaveBeenCalled())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('⌘+ menaikkan font xterm (settings default), ⌘0 mereset', async () => {
    hostSize = 400
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await waitFor(() => expect(ofType('open')).toHaveLength(1))
    const ta = document.querySelector<HTMLTextAreaElement>('.react-flow__node-terminal .xterm-helper-textarea')
    expect(ta).not.toBeNull()
    const size = () => terms[0]?.options.fontSize
    const base = size()
    expect(base).toBeTypeOf('number')
    const press = (init: KeyboardEventInit) =>
      ta!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

    // Chord primer bergantung platform; jsdom bukan mac, jadi pakai Ctrl (di mac: ⌘).
    press({ key: '=', code: 'Equal', ctrlKey: true })
    await waitFor(() => expect(size()).toBe(base! + 1))
    press({ key: '0', code: 'Digit0', ctrlKey: true })
    await waitFor(() => expect(size()).toBe(base))
  })
})
