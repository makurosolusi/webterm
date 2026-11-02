import { describe, expect, it } from 'vitest'
import { spawnSpot } from './canvasMenu.geometry'

describe('spawnSpot', () => {
  it('meneruskan titik klik yang valid', () => {
    expect(spawnSpot({ x: 12, y: -4 })).toEqual({ x: 12, y: -4 })
  })

  it('undefined saat tidak ada titik', () => {
    expect(spawnSpot(undefined)).toBeUndefined()
  })

  it('menolak NaN dan Infinity — event klik tombol bukan titik spawn', () => {
    expect(spawnSpot({ x: Number.NaN, y: 1 })).toBeUndefined()
    expect(spawnSpot({ x: 1, y: Number.POSITIVE_INFINITY })).toBeUndefined()
    // test-only: nilai berbentuk event, bukan titik
    expect(spawnSpot({} as never)).toBeUndefined()
  })
})
