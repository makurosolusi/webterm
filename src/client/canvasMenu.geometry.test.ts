import { describe, expect, it } from 'vitest'
import {
  MENU_VIEWPORT_MARGIN as M,
  SUBMENU_OVERLAP_PX,
  SUBMENU_TOP_PX,
  clampMenuPosition,
  submenuLift,
  submenuSide,
} from './canvasMenu.geometry'

const VW = 1000
const VH = 800

const place = (x: number, y: number, width = 240, height = 300) =>
  clampMenuPosition({ x, y, width, height, viewportWidth: VW, viewportHeight: VH })

describe('clampMenuPosition', () => {
  it('membiarkan menu di kursor saat muat', () => {
    expect(place(100, 100)).toEqual({ x: 100, y: 100 })
  })

  it('membuka ke ATAS saat akan menembus tepi bawah', () => {
    // 700 + 300 = 1000 > 800 - 6 → bawahnya dijangkarkan ke titik klik.
    expect(place(100, 700).y).toBe(400)
  })

  it('menggeser masuk saat akan menembus tepi kanan, bukan membalik ke kiri kursor', () => {
    expect(place(900, 100).x).toBe(VW - 240 - M)
  })

  it('membalik dan menggeser pada sekaligus kedua tepi — sudut kanan-bawah', () => {
    expect(place(980, 790)).toEqual({ x: VW - 240 - M, y: 790 - 300 })
  })

  it('tidak pernah menaruh menu di luar tepi kiri/atas, bahkan saat lebih besar dari viewport', () => {
    const huge = clampMenuPosition({
      x: 10,
      y: 10,
      width: VW + 500,
      height: VH + 500,
      viewportWidth: VW,
      viewportHeight: VH,
    })
    expect(huge.x).toBe(M)
    expect(huge.y).toBe(M)
  })

  it('menu yang persis muat tidak digeser', () => {
    expect(place(VW - 240 - M, VH - 300 - M)).toEqual({ x: VW - 240 - M, y: VH - 300 - M })
  })
})

const side = (rowLeft: number, rowRight: number, width = 200) =>
  submenuSide({ rowLeft, rowRight, width, viewportWidth: VW })

describe('submenuSide', () => {
  it('membuka ke kanan saat ada ruang', () => {
    expect(side(100, 340)).toBe('right')
  })

  it('membuka ke KIRI saat menu berada di tepi kanan jendela', () => {
    expect(side(750, 990)).toBe('left')
  })

  it('batas tepat: flyout yang persis muat di kanan tetap ke kanan', () => {
    // rowRight - overlap + width === VW - M
    const rowRight = VW - M - 200 + SUBMENU_OVERLAP_PX
    expect(side(rowRight - 240, rowRight)).toBe('right')
    expect(side(rowRight - 240 + 1, rowRight + 1)).toBe('left')
  })

  it('saat tak ada sisi yang muat, sisi yang lebih longgar yang menang', () => {
    // Jendela sempit, flyout lebar: kedua sisi gagal, jadi yang diperiksa adalah ruangnya.
    const narrow = { width: 400, viewportWidth: 500 }
    expect(submenuSide({ rowLeft: 20, rowRight: 120, ...narrow })).toBe('right')
    expect(submenuSide({ rowLeft: 380, rowRight: 480, ...narrow })).toBe('left')
  })
})

describe('submenuLift', () => {
  it('tidak mengangkat flyout yang muat', () => {
    expect(submenuLift({ rowTop: 100, height: 200, viewportHeight: VH })).toBe(0)
  })

  it('mengangkat tepat sebanyak kelebihannya', () => {
    // top = 700 - 6 = 694; 694 + 200 = 894; batas 800 - 6 = 794 → kelebihan 100.
    expect(submenuLift({ rowTop: 700, height: 200, viewportHeight: VH })).toBe(100)
  })

  it('setelah diangkat, bawah flyout berada di dalam margin', () => {
    const rowTop = 700
    const height = 200
    const lift = submenuLift({ rowTop, height, viewportHeight: VH })
    expect(rowTop + SUBMENU_TOP_PX - lift + height).toBeLessThanOrEqual(VH - M)
  })

  it('tidak pernah mengangkat melewati margin atas — flyout lebih tinggi dari viewport menggulir', () => {
    const lift = submenuLift({ rowTop: 400, height: VH * 2, viewportHeight: VH })
    expect(400 + SUBMENU_TOP_PX - lift).toBeGreaterThanOrEqual(M)
  })
})
