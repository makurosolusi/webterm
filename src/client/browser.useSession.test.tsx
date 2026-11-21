/** @vitest-environment jsdom */
// Urutan gambar frame: hanya frame terbaru yang tergambar, dan frame transisi resize dibuang.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESIZE_DEBOUNCE_MS } from '../shared/browser.contract'
import type { ClientMsg } from '../shared/browser.contract'
import type { BrowserListener, BrowserStream } from './browser.stream'
import { RESIZE_FILTER_MAX_DROPS, RESIZE_FILTER_MAX_MS } from './browser.stream.fit'
import { useBrowserSession } from './browser.useSession'

type RoCb = (e: Array<{ contentRect: { width: number; height: number } }>) => void
let roCb: RoCb | null = null
class FakeRO { constructor(cb: RoCb) { roCb = cb } observe() {} disconnect() {} }

let listener: BrowserListener | null = null
const sent: ClientMsg[] = []
const stream: BrowserStream = {
  subscribe: (_id, l) => { listener = l; return () => undefined },
  attach: () => undefined,
  resize: () => undefined,
  detach: () => undefined,
  send: (m) => { sent.push(m) },
  reset: () => undefined, setAudio: () => undefined,
}

// createImageBitmap palsu: selesai saat test memanggil `finish(i)`; ukuran bitmap dari byte jpeg [w/10, h/10, seq].
let decodes: Array<() => void> = []
const drawn: number[] = []
function Probe() {
  const s = useBrowserSession('b1', false, stream)
  return <div ref={s.hostRef}><canvas ref={s.canvasRef} /></div>
}
const resizeTo = (width: number, height: number) => act(() => roCb?.([{ contentRect: { width, height } }]))
const frame = (seq: number, w: number, h: number) => act(() => listener?.onFrame(seq, new Uint8Array([w / 10, h / 10, seq])))
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const finish = async (i: number) => { decodes[i](); await settle() }

beforeEach(() => {
  decodes = []; drawn.length = 0; sent.length = 0; listener = null
  vi.stubGlobal('ResizeObserver', FakeRO)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
    const [w, h, seq] = new Uint8Array(await blob.arrayBuffer())
    await new Promise<void>((r) => decodes.push(r))
    return { width: w * 10, height: h * 10, close: () => undefined, seq }
  }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    drawImage: (b: { seq: number }) => { drawn.push(b.seq) },
  })) as never)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('useBrowserSession paint', () => {
  it('drops a frame whose decode finishes after a newer frame was painted, but still acks it', async () => {
    render(<Probe />)
    resizeTo(800, 600)
    frame(1, 800, 600); frame(2, 800, 600)
    await settle()
    await finish(1) // frame 2 selesai duluan
    await finish(0)
    expect(drawn).toEqual([2])
    expect(sent.filter((m) => m.t === 'ack').map((m) => (m as { seq: number }).seq)).toEqual([2, 1])
  })

  it('after a resize drops transitional frames of the old size until a matching one arrives', async () => {
    render(<Probe />)
    resizeTo(800, 600)
    vi.useFakeTimers()
    resizeTo(1000, 700)
    act(() => { vi.advanceTimersByTime(150) }) // resize terkirim ke server
    vi.useRealTimers()
    frame(1, 800, 600); frame(2, 1000, 700); frame(3, 800, 600)
    await settle()
    for (let i = 0; i < 3; i++) await finish(i)
    // frame 3 datang sesudah frame yang cocok: tak lagi difilter (hanya transisi sesudah resize yang dibuang)
    expect(drawn).toEqual([2, 3])
  })

  const resized = async () => {
    render(<Probe />)
    resizeTo(800, 600)
    resizeTo(1000, 700)
    await act(() => new Promise((r) => setTimeout(r, RESIZE_DEBOUNCE_MS + 10))) // resize terkirim; filter aktif
  }

  it('fallback: no compatible frame within RESIZE_FILTER_MAX_MS paints the latest held frame', async () => {
    await resized()
    frame(1, 800, 600); frame(2, 800, 600)
    await settle()
    await finish(0); await finish(1)
    expect(drawn).toEqual([]) // masih ditahan
    await act(() => new Promise((r) => setTimeout(r, RESIZE_FILTER_MAX_MS))) // timer nyata: dijadwalkan saat resize
    expect(drawn).toEqual([2]) // node tidak membeku: frame tertahan terbaru digambar
  })

  it('fallback: after RESIZE_FILTER_MAX_DROPS incompatible frames the filter turns off', async () => {
    await resized()
    for (let i = 1; i <= RESIZE_FILTER_MAX_DROPS; i++) frame(i, 800, 600)
    await settle()
    for (let i = 0; i < RESIZE_FILTER_MAX_DROPS; i++) await finish(i)
    expect(drawn).toEqual([RESIZE_FILTER_MAX_DROPS]) // frame ke-N digambar walau ukurannya tak cocok
    frame(99, 800, 600)
    await settle()
    await finish(RESIZE_FILTER_MAX_DROPS)
    expect(drawn).toEqual([RESIZE_FILTER_MAX_DROPS, 99]) // filter sudah mati
  })
})

describe('useBrowserSession input latency (I1-d)', () => {
  it('stamps sent input with ls, and records the frame that echoes it after paint', async () => {
    let session: ReturnType<typeof useBrowserSession> | null = null
    function LatProbe() {
      session = useBrowserSession('b1', false, stream)
      return <div ref={session.hostRef}><canvas ref={session.canvasRef} /></div>
    }
    render(<LatProbe />)
    resizeTo(800, 600)
    const mouse = { t: 'mouse', x: 1, y: 1, button: 'none', buttons: 0, clickCount: 0, mods: 0, dx: 0, dy: 0 } as const
    act(() => session!.send({ ...mouse, type: 'move' }))
    act(() => session!.send({ ...mouse, type: 'wheel', dy: 40 }))
    const [move, wheel] = sent.filter((m) => m.t === 'mouse') as Array<{ ls?: number }>
    expect(move.ls).toBeUndefined()
    expect(typeof wheel.ls).toBe('number')
    act(() => listener?.onFrame(1, new Uint8Array([80, 60, 1]), { ls: wheel.ls!, rxToDispatch: 0, dispatchToSwap: 0, swapToServer: 0 }))
    await settle()
    await finish(0)
    expect(drawn).toEqual([1])
    expect(session!.latency.count).toBe(1)
    expect(session!.latency.total[0]).toBeGreaterThanOrEqual(0)
  })
})
