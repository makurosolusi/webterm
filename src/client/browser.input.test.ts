import { describe, expect, it, vi } from 'vitest'
import type { TouchPoint } from '../shared/browser.contract'
import { parseClientMsg } from '../shared/browser.wire'
import { chunkText, classifyKey, keyMsg, makeClickCounter, makeMoveCoalescer, modsOf, mouseMsg, touchMsg, wheelMsg } from './browser.input'
import type { KeyLike, PointerLike, WheelLike } from './browser.input'

const noMods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const ptr = (o: Partial<PointerLike> = {}): PointerLike => ({
  ...noMods, clientX: 150, clientY: 130, button: 0, buttons: 1, pointerId: 1, pressure: 0.5, ...o,
})
const key = (o: Partial<KeyLike> = {}): KeyLike => ({ ...noMods, key: 'a', code: 'KeyA', keyCode: 65, isComposing: false, ...o })
const VP = { w: 800, h: 600 }

describe('browser.input', () => {
  it('modsOf: bitmask Alt=1 Ctrl=2 Meta=4 Shift=8', () => {
    expect(modsOf(noMods)).toBe(0)
    expect(modsOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
    expect(modsOf({ ...noMods, ctrlKey: true, shiftKey: true })).toBe(10)
  })

  it('mouseMsg: koordinat sama pada zoom 0.1/1/2 (rect berskala), dan lolos parser kawat', () => {
    // Elemen 800x600 di layout; pada zoom z rect = 800z x 600z, titik di tengah selalu (400,300).
    for (const z of [0.1, 1, 2]) {
      const rect = { left: 100, top: 50, width: 800 * z, height: 600 * z }
      const m = mouseMsg('down', ptr({ clientX: 100 + 400 * z, clientY: 50 + 300 * z }), rect, VP, 2)
      expect(m?.x).toBeCloseTo(400, 6)
      expect(m?.y).toBeCloseTo(300, 6)
      expect(m).toMatchObject({ t: 'mouse', type: 'down', button: 'left', clickCount: 2 })
      expect(parseClientMsg({ ...m, id: 'n1' })).not.toBeNull()
    }
  })

  it('mouseMsg: rect nol -> null; move memakai button none dan clickCount 0; tombol kanan', () => {
    expect(mouseMsg('move', ptr(), { left: 0, top: 0, width: 0, height: 0 }, VP)).toBeNull()
    const rect = { left: 0, top: 0, width: 800, height: 600 }
    expect(mouseMsg('move', ptr(), rect, VP, 3)).toMatchObject({ button: 'none', clickCount: 0 })
    expect(mouseMsg('up', ptr({ button: 2 }), rect, VP, 1)?.button).toBe('right')
    expect(mouseMsg('up', ptr({ button: 9 }), rect, VP, 1)?.button).toBe('none')
  })

  it('wheelMsg: Ctrl+wheel tidak diteruskan; deltaMode baris/halaman diskalakan', () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 }
    const w = (o: Partial<WheelLike>): WheelLike =>
      ({ ...noMods, clientX: 10, clientY: 10, deltaX: 0, deltaY: 100, deltaMode: 0, buttons: 0, ...o })
    expect(wheelMsg(w({ ctrlKey: true }), rect, VP)).toBeNull()
    expect(wheelMsg(w({}), rect, VP)).toMatchObject({ type: 'wheel', dy: 100 })
    expect(wheelMsg(w({ deltaMode: 1, deltaY: 3 }), rect, VP)?.dy).toBe(48)
    expect(wheelMsg(w({ deltaMode: 2, deltaY: 1 }), rect, VP)?.dy).toBe(600)
  })

  it('touchMsg: melacak titik aktif; end membuang titik', () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 }
    const active = new Map<number, TouchPoint>()
    const a = touchMsg('start', ptr({ pointerId: 1 }), active, rect, VP)
    const b = touchMsg('start', ptr({ pointerId: 2, clientX: 10 }), active, rect, VP)
    expect(a?.points).toHaveLength(1)
    expect(b?.points.map((p) => p.id)).toEqual([1, 2])
    expect(touchMsg('end', ptr({ pointerId: 1 }), active, rect, VP)?.points.map((p) => p.id)).toEqual([2])
    expect(parseClientMsg({ ...b, id: 'n1' })).not.toBeNull()
  })

  it('classifyKey: copy/paste/IME dikenali', () => {
    expect(classifyKey(key({ key: 'c', ctrlKey: true }))).toBe('copy')
    expect(classifyKey(key({ key: 'C', metaKey: true }))).toBe('copy')
    expect(classifyKey(key({ key: 'v', metaKey: true }))).toBe('paste')
    expect(classifyKey(key({ isComposing: true }))).toBe('ignore')
    expect(classifyKey(key({ keyCode: 229 }))).toBe('ignore')
    expect(classifyKey(key({ key: 'Tab' }))).toBe('key')
  })

  it('keyMsg: text hanya untuk karakter tercetak tanpa Ctrl/Meta; Enter = CR', () => {
    expect(keyMsg('down', key()).text).toBe('a')
    expect(keyMsg('down', key({ ctrlKey: true })).text).toBe('')
    expect(keyMsg('down', key({ key: 'Tab', code: 'Tab', keyCode: 9 })).text).toBe('')
    expect(keyMsg('down', key({ key: 'Enter', code: 'Enter', keyCode: 13 })).text).toBe('\r')
    expect(keyMsg('up', key({ shiftKey: true }))).toMatchObject({ type: 'up', vk: 65, mods: 8 })
    expect(parseClientMsg({ ...keyMsg('down', key()), id: 'n1' })).not.toBeNull()
  })

  it('chunkText: tiap potongan muat, gabungan utuh, surrogate tidak terbelah', () => {
    expect(chunkText('')).toEqual([])
    const text = 'a😀b😀c😀d'
    const parts = chunkText(text, 2)
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2)
    for (const p of parts) expect(p).not.toMatch(/[\ud800-\udbff]$/)
    expect(chunkText('x'.repeat(40_000)).every((p) => new TextEncoder().encode(p).length <= 64 * 1024)).toBe(true)
  })

  it('makeClickCounter: klik dekat+cepat naik, jauh atau lambat reset', () => {
    let t = 0
    const next = makeClickCounter(() => t)
    expect(next(10, 10)).toBe(1)
    t = 200
    expect(next(12, 11)).toBe(2)
    t = 300
    expect(next(100, 100)).toBe(1)
    t = 1000
    expect(next(100, 100)).toBe(1)
  })

  it('makeMoveCoalescer: move dibatasi per interval, trailing terkirim, flush mendahului up', () => {
    vi.useFakeTimers()
    try {
      const sent: Array<[string, number]> = []
      const c = makeMoveCoalescer((m) => sent.push([m.type, m.x]), 16)
      const mv = (x: number) => ({ ...mouseMsg('move', ptr(), { left: 0, top: 0, width: 800, height: 600 }, VP)!, x })
      c.move(mv(1)); c.move(mv(2)); c.move(mv(3))
      expect(sent).toEqual([['move', 1]]) // leading langsung, sisanya digabung
      vi.advanceTimersByTime(16)
      expect(sent).toEqual([['move', 1], ['move', 3]]) // trailing = move terakhir
      c.move(mv(4)); c.move(mv(5))
      c.flush() // ala mouseup: move terakhir keluar sebelum up
      sent.push(['up', 0])
      expect(sent.slice(-2)).toEqual([['move', 5], ['up', 0]])
      vi.advanceTimersByTime(100)
      expect(sent).toHaveLength(4) // tak ada kiriman ganda setelah flush
      c.dispose()
    } finally { vi.useRealTimers() }
  })
})
