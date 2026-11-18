/** @vitest-environment jsdom */
// Canvas is faked: the stand-in records the drawing calls, so the tests check WHAT is composed, not how it looks.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canCopyImage, copyPng, exportName, renderComposite, savePng } from './compare.export'
import type { ExportView, MakeCanvas } from './compare.export'
import { makePixels } from './diff'

const calls: string[] = []
const make: MakeCanvas = (w, h) => {
  const id = `c${calls.length}`
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => k in t ? t[k] : k === 'createImageData' ? (iw: number, ih: number) => makePixels(iw, ih) : (...a: unknown[]) => { calls.push(`${id}.${k}(${a.map((x) => (typeof x === 'object' ? 'obj' : String(x))).join(',')})`) },
    set: (t, k: string, v) => { t[k] = v; calls.push(`${id}.${k}=${String(v)}`); return true },
  })
  return { width: w, height: h, getContext: () => ctx, toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'], { type: 'image/png' })) } as unknown as HTMLCanvasElement
}
const px = (v: number) => { const p = makePixels(10, 4); p.data.fill(v); return p }
const view = (over: Partial<ExportView>): ExportView => ({ mode: 'swipe', swipe: 30, onion: 50, a: px(1), b: px(2), ...over })

afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('renderComposite', () => {
  it('swipe: Compare is drawn only right of the divider', () => {
    renderComposite(view({ mode: 'swipe', swipe: 30 }), make)
    expect(calls.some((c) => c.endsWith('.rect(3,0,10,4)'))).toBe(true)
    expect(calls.some((c) => c.endsWith('.clip()'))).toBe(true)
  })
  it('onion: Compare is drawn at its opacity', () => {
    renderComposite(view({ mode: 'onion', onion: 25 }), make)
    expect(calls).toContain('c0.globalAlpha=0.25')
  })
  it('diff: the base is dimmed and the red map is drawn on top', () => {
    renderComposite(view({ mode: 'diff', diff: px(9) }), make)
    expect(calls).toContain('c0.globalAlpha=0.65')
    expect(calls.filter((c) => c.startsWith('c0.drawImage')).length).toBe(2)
  })
  it('names the file by local time', () => {
    expect(exportName(new Date(2026, 10, 18, 9, 5, 7))).toBe('webterm-compare-20261118-090507.png')
  })
})

describe('savePng', () => {
  it('downloads one PNG and revokes the object URL', async () => {
    const create = vi.fn(() => 'blob:x'), revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    expect(await savePng(view({}), new Date(2026, 0, 2, 3, 4, 5), make)).toEqual({ ok: true })
    expect(click).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:x')
  })

  it('reports an encoding failure instead of throwing', async () => {
    const bad: MakeCanvas = (w, h) => ({ ...make(w, h), toBlob: (cb: (b: Blob | null) => void) => cb(null) }) as unknown as HTMLCanvasElement
    const r = await savePng(view({}), new Date(), bad)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/Could not save the comparison.*could not be encoded/)
  })
})

describe('copyPng', () => {
  it('without clipboard image support it points to Save', async () => {
    expect(canCopyImage()).toBe(false)
    const r = await copyPng(view({}), make)
    expect(r).toEqual({ ok: false, message: 'Copying images is not supported in this browser. Use Save as PNG.' })
  })

  it('writes a PNG item when supported', async () => {
    const write = vi.fn(() => Promise.resolve())
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: unknown) {} })
    vi.stubGlobal('navigator', { clipboard: { write } })
    expect(await copyPng(view({}), make)).toEqual({ ok: true })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('a denied permission becomes a friendly message', async () => {
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: unknown) {} })
    vi.stubGlobal('navigator', { clipboard: { write: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) } })
    const r = await copyPng(view({}), make)
    expect(r.ok === false && r.message).toMatch(/blocked clipboard access/)
  })
})
