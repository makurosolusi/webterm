/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const domToBlob = vi.fn()
vi.mock('modern-screenshot', () => ({ domToBlob: (...a: unknown[]) => domToBlob(...a) }))

class FakeWS {
  static instances: FakeWS[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.instances.push(this) }
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', FakeWS)

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })

const fetchMock = vi.fn()
const shot = { t: 'shot' as const, reqId: 'r1', maxWidth: 800 }
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  visibility = 'visible'
  domToBlob.mockReset()
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
})
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('canvas.screenshot (t:shot)', () => {
  test('ws dispatches shot frames; the hook answers them by uploading', async () => {
    vi.resetModules()
    const ws = await import('./ws')
    const { useCanvasShot } = await import('./canvasShot')
    domToBlob.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }))
    const got: unknown[] = []
    ws.subscribeShot((m) => got.push(m))
    renderHook(() => useCanvasShot())
    ws.subscribe('t1', () => {}, () => {})
    FakeWS.instances.at(-1)!.onmessage!({ data: JSON.stringify(shot) })
    await flush()
    expect(got).toEqual([shot])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('visible window: captures the viewport scaled to maxWidth as JPEG and POSTs it', async () => {
    const { answerShot, SHOT_QUALITY } = await import('./canvasShot')
    const blob = new Blob(['jpg'], { type: 'image/jpeg' })
    domToBlob.mockResolvedValue(blob)
    await answerShot({ ...shot, reqId: 'r/1' })
    expect(domToBlob).toHaveBeenCalledWith(document.body, expect.objectContaining({ type: 'image/jpeg', quality: SHOT_QUALITY, scale: 0.5, width: 1600, height: 900 }))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/canvas-shot/r%2F1')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'image/jpeg' })
    expect(init.body).toBe(blob)
  })

  test('never upscales a page narrower than maxWidth', async () => {
    const { answerShot } = await import('./canvasShot')
    domToBlob.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }))
    await answerShot({ ...shot, maxWidth: 4000 })
    expect(domToBlob.mock.calls[0][1].scale).toBe(1)
  })

  test('hidden tab stays silent: no capture, no upload', async () => {
    const { answerShot } = await import('./canvasShot')
    visibility = 'hidden'
    await answerShot(shot)
    expect(domToBlob).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('capture failure posts the json error code instead of throwing', async () => {
    const { answerShot } = await import('./canvasShot')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    domToBlob.mockRejectedValue(new Error('canvas tainted'))
    await expect(answerShot(shot)).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/canvas-shot/r1')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({ error: 'capture_failed' })
  })

  test('an image over the upload cap is reported as capture_failed', async () => {
    const { answerShot, SHOT_MAX_BYTES } = await import('./canvasShot')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    domToBlob.mockResolvedValue({ size: SHOT_MAX_BYTES + 1, type: 'image/jpeg' })
    await answerShot(shot)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ error: 'capture_failed' })
  })

  test('404/409 (another tab answered, or expired) are ignored silently; other errors are logged', async () => {
    const { answerShot } = await import('./canvasShot')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    domToBlob.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }))
    for (const status of [404, 409]) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }))
      await answerShot(shot)
    }
    expect(warn).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
    await answerShot(shot)
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    await expect(answerShot(shot)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  // Root cause of the frozen tab: cloning every element under body, with ~400 computed styles plus
  // scrollbar pseudo-elements each, synchronously; and a retry starting a second clone on top.
  test('policy: clones only through a filter, without scrollbar pseudo-elements', async () => {
    const { answerShot } = await import('./canvasShot')
    domToBlob.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }))
    await answerShot(shot)
    const opts = domToBlob.mock.calls[0][1]
    expect(typeof opts.filter).toBe('function')
    expect(opts.features.copyScrollbar).toBe(false)
  })

  test('policy: a page over MAX_SHOT_ELEMENTS answers page_too_large without cloning', async () => {
    const { answerShot } = await import('./canvasShot')
    const { MAX_SHOT_ELEMENTS } = await import('./canvasShot.scope')
    const box = document.createElement('div')
    for (let i = 0; i <= MAX_SHOT_ELEMENTS; i++) box.appendChild(document.createElement('span'))
    document.body.appendChild(box)
    await answerShot(shot)
    expect(domToBlob).not.toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ error: 'page_too_large' })
  })

  test('policy: a second request while one captures answers capture_busy; one clone only', async () => {
    const { answerShot } = await import('./canvasShot')
    let finish!: (b: Blob) => void
    domToBlob.mockReturnValue(new Promise<Blob>((r) => { finish = r }))
    const first = answerShot(shot)
    await answerShot({ ...shot, reqId: 'r2' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/canvas-shot/r2')
    expect(JSON.parse(init.body)).toEqual({ error: 'capture_busy' })
    finish(new Blob(['jpg'], { type: 'image/jpeg' }))
    await first
    expect(domToBlob).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/canvas-shot/r1')
    // The flag is released: the next request captures again.
    domToBlob.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }))
    await answerShot(shot)
    expect(domToBlob).toHaveBeenCalledTimes(2)
  })

  // Root cause of blank terminals in screenshots: a WebGL canvas without preserveDrawingBuffer
  // reads back empty through toDataURL, which is how the capture library copies <canvas> pixels.
  test('policy: TerminalCore creates the WebGL addon with preserveDrawingBuffer', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TerminalCore.tsx'), 'utf8') // jsdom's URL rejects file:
    const made = src.match(/new WebglAddon\([^)]*\)/g)
    expect(made).toEqual(['new WebglAddon(true)'])
  })
})
