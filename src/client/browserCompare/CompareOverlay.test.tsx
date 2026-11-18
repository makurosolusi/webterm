/** @vitest-environment jsdom */
// jsdom has no real canvas: getContext is replaced by a stand-in that serves the pixels of each test pane and swallows
// drawing. So these tests cover state, wiring, keyboard and the data flow; what the layers LOOK like is not verifiable here.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompareOverlay } from './CompareOverlay'
import type { CompareOverlayProps } from './CompareOverlay'
import { makePixels } from './diff'
import type { Pixels } from './diff'
import type { WorkerLike } from './diff.run'

const frames = new Map<HTMLCanvasElement, Pixels>()
const reads = vi.fn()
const solid = (w: number, h: number, v: number): Pixels => { const p = makePixels(w, h); for (let i = 0; i < p.data.length; i += 4) p.data.set([v, v, v, 255], i); return p }

/** One pane of the node: `[data-pane-tab]` group with its canvas, as BrowserPane renders it. */
function pane(root: HTMLElement, tabId: string, title: string, px: Pixels | null): void {
  const g = document.createElement('div')
  g.setAttribute('data-pane-tab', tabId); g.setAttribute('aria-label', `Pane: ${title}`)
  const c = document.createElement('canvas')
  if (px) { c.width = px.width; c.height = px.height; frames.set(c, px) }
  g.appendChild(c); root.appendChild(g)
}

beforeEach(() => {
  frames.clear(); reads.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      getImageData: () => { reads(); return frames.get(this) ?? makePixels(this.width, this.height) },
      createImageData: (w: number, h: number) => makePixels(w, h), putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D
  } as never)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

const node = (a: Pixels | null = solid(8, 4, 10), b: Pixels | null = solid(8, 4, 10)): HTMLElement => {
  const root = document.createElement('div')
  pane(root, 't1', 'Home', a); pane(root, 't2', 'Pricing', b)
  return root
}
const instant: CompareOverlayProps['run'] = { makeWorker: () => null, schedule: (fn) => queueMicrotask(fn) }
function open(root: HTMLElement, over: Partial<CompareOverlayProps> = {}, wrap: (n: ReactNode) => ReactNode = (n) => n) {
  const props: CompareOverlayProps = { root, ids: { left: 't1', right: 't2' }, names: { t1: 'Home', t2: 'Pricing' }, onClose: vi.fn(), onWake: vi.fn(), run: instant, ...over }
  return { props, ...render(<TooltipProvider>{wrap(<CompareOverlay {...props} />)}</TooltipProvider>) }
}
const tab = (name: string) => screen.getByRole('tab', { name })
const pickMode = (name: string) => { fireEvent.mouseDown(tab(name), { button: 0 }); fireEvent.focus(tab(name)) }

describe('capture', () => {
  it('captures both panes on open, shows when, and never polls', () => {
    vi.useFakeTimers()
    open(node())
    expect(reads).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/^Captured \d\d:\d\d:\d\d$/)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(reads).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh capture' }))
    expect(reads).toHaveBeenCalledTimes(4)
  })

  it('layers both captures in swipe mode (Base and Compare images)', () => {
    open(node())
    expect(screen.getByRole('img', { name: 'Base: Home' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Compare: Pricing' })).toBeTruthy()
  })

  it('warns when the sizes differ and can switch to actual size', () => {
    open(node(solid(390, 844, 5), solid(1280, 800, 5)))
    expect(screen.getByText('Sizes differ (390 x 844 vs 1280 x 800); scaled to fit')).toBeTruthy()
    const actual = screen.getByRole('button', { name: 'Compare at actual size' })
    expect(actual.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(actual)
    expect(actual.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(/scaled to fit/)).toBeNull()
  })

  it('same sizes: no warning and no actual-size button', () => {
    open(node())
    expect(screen.queryByText(/Sizes differ/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compare at actual size' })).toBeNull()
  })
})

describe('states', () => {
  it('a pane that is gone says so and offers no Wake', () => {
    const root = node(); root.querySelector('[data-pane-tab="t2"]')?.remove()
    open(root)
    expect(screen.getByRole('alert', { name: 'Compare capture failed' }).textContent).toMatch(/no longer on screen/)
    expect(screen.queryByRole('button', { name: 'Wake' })).toBeNull()
  })

  it('a tab without a picture (asleep or crashed) offers Wake, and Retry reads again', () => {
    const { props } = open(node(solid(8, 4, 10), null))
    expect(screen.getByRole('alert', { name: 'Compare capture failed' }).textContent).toMatch(/Pricing.*no picture yet/)
    fireEvent.click(screen.getByRole('button', { name: 'Wake' }))
    expect(props.onWake).toHaveBeenCalledWith('t2')
    const before = reads.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reads.mock.calls.length).toBeGreaterThan(before)
  })

  it('a read error becomes a message with Retry instead of a crash', () => {
    const root = node()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ getImageData: () => { throw new Error('tainted canvas') } })) as never)
    open(root)
    expect(screen.getAllByRole('alert')[0].textContent).toMatch(/Could not capture "Home".*tainted canvas/)
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0)
  })
})

describe('swipe slider', () => {
  it('is a labelled slider moved by arrows, Shift+arrows, Home and End', () => {
    open(node())
    const s = screen.getByRole('slider', { name: 'Swipe position' })
    expect(s.getAttribute('aria-valuenow')).toBe('50')
    fireEvent.keyDown(s, { key: 'ArrowRight' }); expect(s.getAttribute('aria-valuenow')).toBe('51')
    fireEvent.keyDown(s, { key: 'ArrowLeft', shiftKey: true }); expect(s.getAttribute('aria-valuenow')).toBe('41')
    fireEvent.keyDown(s, { key: 'Home' }); expect(s.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(s, { key: 'ArrowLeft' }); expect(s.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(s, { key: 'End' }); expect(s.getAttribute('aria-valuenow')).toBe('100')
  })

  it('follows the pointer across its track', () => {
    open(node())
    const s = screen.getByRole('slider', { name: 'Swipe position' })
    s.parentElement!.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 100, right: 300, bottom: 100, x: 100, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(s, { clientX: 250, pointerId: 1 })
    expect(s.getAttribute('aria-valuenow')).toBe('75')
    fireEvent.pointerMove(s, { clientX: 150, pointerId: 1 })
    expect(s.getAttribute('aria-valuenow')).toBe('25')
    fireEvent.pointerUp(s, { clientX: 150, pointerId: 1 })
    fireEvent.pointerMove(s, { clientX: 290, pointerId: 1 })
    expect(s.getAttribute('aria-valuenow')).toBe('25') // released: no more dragging
  })
})

describe('modes', () => {
  it('onion skin shows an opacity slider that drives the Compare layer', () => {
    open(node())
    pickMode('Onion skin')
    const s = screen.getByRole('slider', { name: 'Compare opacity' })
    fireEvent.keyDown(s, { key: 'End' })
    expect(s.getAttribute('aria-valuetext')).toBe('100%')
    expect(screen.getByRole('img', { name: 'Compare: Pricing' }).style.opacity).toBe('1')
    fireEvent.keyDown(s, { key: 'Home' })
    expect(screen.getByRole('img', { name: 'Compare: Pricing' }).style.opacity).toBe('0')
  })

  it('difference reports the share of differing pixels in a live region, and the tolerance stepper recomputes', async () => {
    const b = solid(8, 4, 10); b.data.set([90, 90, 90, 255], 0) // 1 of 32 pixels, distance 80 = 31%
    open(node(solid(8, 4, 10), b))
    pickMode('Difference')
    expect(await screen.findByText('3.1% of pixels differ')).toBeTruthy()
    expect(screen.getByText('3.1% of pixels differ').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByRole('img', { name: 'Pixels that differ, in red' })).toBeTruthy()
    const raise = screen.getByRole('button', { name: 'Raise tolerance' })
    for (let i = 0; i < 40; i++) fireEvent.click(raise) // 5 -> 45: above the 31% distance, nothing differs
    expect(screen.getByLabelText('Tolerance value').textContent).toBe('45')
    expect(await screen.findByText('0% of pixels differ')).toBeTruthy()
    for (let i = 0; i < 20; i++) fireEvent.click(raise)
    expect(screen.getByLabelText('Tolerance value').textContent).toBe('50') // capped
    expect((screen.getByRole('button', { name: 'Raise tolerance' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the legend names what red means', () => {
    open(node())
    pickMode('Difference')
    expect(screen.getByText(/Differs/)).toBeTruthy()
  })
})

describe('computing', () => {
  const pending = (): { w: WorkerLike; terminated: () => number } => {
    let n = 0
    const w: WorkerLike = { onmessage: null, onerror: null, postMessage() {}, terminate() { n++ } }
    return { w, terminated: () => n }
  }

  it('shows Computing... with Cancel, and Cancel stops the worker', () => {
    const { w, terminated } = pending()
    open(node(), { run: { makeWorker: () => w } })
    pickMode('Difference')
    expect(screen.getByText('Computing...')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(terminated()).toBe(1)
    expect(screen.getByText('Comparison cancelled')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Compute' })).toBeTruthy()
  })

  it('closing the overlay while computing releases the worker', () => {
    const { w, terminated } = pending()
    const { unmount } = open(node(), { run: { makeWorker: () => w } })
    pickMode('Difference')
    unmount()
    expect(terminated()).toBe(1)
  })
})

describe('close', () => {
  it('Escape and the Close button both close', () => {
    const { props } = open(node())
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Compare panes' }), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close comparison' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})

describe('export buttons', () => {
  it('Save is enabled once there is something to export; Copy only where the clipboard can take images', () => {
    open(node())
    expect((screen.getByRole('button', { name: /Save comparison as PNG/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull() // jsdom has no ClipboardItem
  })

  it('Save is disabled when a capture failed', () => {
    open(node(solid(8, 4, 1), null))
    expect((screen.getByRole('button', { name: /Save comparison as PNG/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
