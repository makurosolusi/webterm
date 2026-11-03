import { describe, expect, it } from 'vitest'
import { ZOOM_PAUSE_BELOW } from '../shared/browser.contract'
import { planBrowserOpen, type PlanNode } from './browser.open.plan'
import {
  ANCHOR_FALLBACK_SIZE,
  BROWSER_OPEN_SIZE as S,
  CASCADE_STEP,
  FIT_MIN_ZOOM,
  OPEN_GAP,
  SCAN_COLS,
  SCAN_ROWS,
  placeBeside,
  rectInView,
  type Rect,
} from './browser.open.place'

const center = { x: 0, y: 0 }
const anchor: Rect = { x: 100, y: 100, width: 400, height: 300 }
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const box = (p: { x: number; y: number }): Rect => ({ ...p, ...S })

describe('placeBeside', () => {
  it('at dipakai apa adanya walau terisi', () => {
    const occ: Rect[] = [{ x: 5, y: 5, width: 900, height: 900 }]
    expect(placeBeside({ at: { x: 10, y: 20 }, anchor, center, occupied: occ, size: S })).toEqual({ x: 10, y: 20 })
  })
  it('kanan bebas -> kanan; kanan terisi -> bawah; kanan+bawah terisi -> kiri', () => {
    const right = { x: anchor.x + anchor.width + OPEN_GAP, y: anchor.y }
    const below = { x: anchor.x, y: anchor.y + anchor.height + OPEN_GAP }
    expect(placeBeside({ anchor, center, occupied: [anchor], size: S })).toEqual(right)
    // penghalang kecil (bukan box penuh) agar kandidat bawah tidak ikut beririsan dengan kanan
    const blockRight: Rect = { ...right, width: 50, height: 50 }
    const blockBelow: Rect = { ...below, width: 50, height: 50 }
    expect(placeBeside({ anchor, center, occupied: [anchor, blockRight], size: S })).toEqual(below)
    expect(placeBeside({ anchor, center, occupied: [anchor, blockRight, blockBelow], size: S })).toEqual({
      x: anchor.x - S.width - OPEN_GAP,
      y: anchor.y,
    })
  })
  it('semua tetangga terisi -> pindai grid, tidak beririsan', () => {
    const occ: Rect[] = [
      anchor,
      box({ x: anchor.x + anchor.width + OPEN_GAP, y: anchor.y }),
      box({ x: anchor.x, y: anchor.y + anchor.height + OPEN_GAP }),
      box({ x: anchor.x - S.width - OPEN_GAP, y: anchor.y }),
    ]
    const p = placeBeside({ anchor, center, occupied: occ, size: S })
    expect(occ.some((o) => overlap(box(p), o))).toBe(false)
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })
  it('grid habis -> kaskade terhingga dari titik awal', () => {
    const occ: Rect[] = [{ x: -1e6, y: -1e6, width: 2e6, height: 2e6 }]
    const p = placeBeside({ anchor, center, occupied: occ, size: S })
    expect(p).toEqual({ x: anchor.x + CASCADE_STEP, y: anchor.y + CASCADE_STEP }) // 1 % 6 = 1
    expect(SCAN_COLS * SCAN_ROWS).toBeGreaterThan(0)
  })
  it('tanpa anchor -> sekitar center - size/2', () => {
    expect(placeBeside({ center: { x: 1000, y: 500 }, occupied: [], size: S })).toEqual({
      x: 1000 - S.width / 2,
      y: 500 - S.height / 2,
    })
  })
  it('tanpa anchor + tengah terisi -> bergeser tanpa irisan', () => {
    const mid = box({ x: -S.width / 2, y: -S.height / 2 })
    const p = placeBeside({ center, occupied: [mid], size: S })
    expect(overlap(box(p), mid)).toBe(false)
  })
  it('ukuran NaN/Infinity/kosong -> fallback, hasil terhingga', () => {
    const bad = { x: NaN, y: Infinity, width: NaN, height: -Infinity } as Rect
    const p = placeBeside({ anchor: bad, center: { x: NaN, y: Infinity }, occupied: [bad], size: S })
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    const q = placeBeside({ center: { x: NaN, y: NaN }, occupied: [bad], size: S })
    expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true)
    // anchor tanpa ukuran terukur: kanan = x + lebar fallback + gap
    const noSize = { x: 10, y: 20 } as Rect
    expect(placeBeside({ anchor: noSize, center, occupied: [], size: S })).toEqual({
      x: 10 + ANCHOR_FALLBACK_SIZE.width + OPEN_GAP,
      y: 20,
    })
  })
  it('planBrowserOpen: measured/width kosong memakai fallback', () => {
    const t: PlanNode = { id: 't', type: 'terminal', position: { x: 0, y: 0 }, measured: {} }
    expect(planBrowserOpen([t], { url: 'https://a.com/', anchorNodeId: 't' }, 'n', center)).toMatchObject({
      position: { x: ANCHOR_FALLBACK_SIZE.width + OPEN_GAP, y: 0 },
    })
  })
})

describe('rectInView', () => {
  const screen = { width: 1000, height: 800 }
  const vp = { x: 0, y: 0, zoom: 1 }
  it('sepenuhnya terlihat (tepi inklusif) vs keluar', () => {
    expect(rectInView({ x: 0, y: 0, width: 1000, height: 800 }, vp, screen)).toBe(true)
    expect(rectInView({ x: 1, y: 0, width: 1000, height: 800 }, vp, screen)).toBe(false)
    expect(rectInView({ x: -1, y: 0, width: 10, height: 10 }, vp, screen)).toBe(false)
  })
  it('memperhitungkan zoom dan translasi viewport', () => {
    const v = { x: 100, y: 50, zoom: 0.5 }
    expect(rectInView({ x: 0, y: 0, width: 640, height: 400 }, v, screen)).toBe(true) // layar 100..420 x 50..250
    expect(rectInView({ x: 1800, y: 0, width: 640, height: 400 }, v, screen)).toBe(false)
  })
})

it('FIT_MIN_ZOOM di atas ambang jeda stream', () => {
  expect(FIT_MIN_ZOOM).toBeGreaterThan(ZOOM_PAUSE_BELOW)
})
