/**
 * @vitest-environment jsdom
 */
// Tombol Sessions SESUDAH ia pindah masuk ke dock, diuji di canvas sungguhan (`./canvasHarness`).
// Sebabnya satu bug nyata: dock dan panel sama-sama diangkur ke tepi kiri, dan kolom dock
// (z-index 20) berdiri persis di atas daftar sesi (z-index 12) sehingga teksnya terpotong.
//
// Yang dijaga di sini:
//   1. Pelontarnya SATU dan ada di dalam dock — tidak ada plat terapung kedua di tepi kiri.
//   2. Klik membuka, klik lagi menutup; hover TIDAK pernah membuka (perilaku yang baru dimenangkan).
//   3. Pilihan buka/tutup bertahan di localStorage, di bawah kunci warisan yang sama.
//   4. Dock minggir saat panel terbuka, bukan sembunyi di belakangnya.
//
// POSISI PIKSEL TIDAK TERUJI: jsdom tidak punya layout. (4) diuji sebagai keadaan yang bisa diamati
// (kelas `dock--shifted`) plus penjaga teks CSS di bawah — yang membaca bahwa geserannya memang
// memakai lebar panel, bukan angka kedua yang disalin tangan.
import { readFileSync } from 'node:fs'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'

/** Kunci warisan dari masa panel ini punya hover-peek. Dipaku sebagai literal DI SINI, bukan
 *  diimpor: nilainya adalah identitas preferensi yang sudah tersimpan di browser pengguna, jadi
 *  test yang mengimpor konstantanya akan tetap hijau justru saat namanya diganti. */
const PIN_KEY = 'webterm.sessionsPinned'

/** Sheet dibaca relatif ke root repo (cwd runner), BUKAN lewat `new URL('./x', import.meta.url)`
 *  seperti `styles.test.ts`: file ini jsdom, dan di transform web Vite memperlakukan pola itu
 *  sebagai URL aset — yang terbaca jadi source test ini sendiri, dan guard di atasnya palsu. */
const read = (f: string) => readFileSync(`src/client/${f}`, 'utf8')

beforeAll(installCanvasDom)
beforeEach(() => localStorage.clear())
afterEach(() => {
  unmountCanvas()
  localStorage.clear()
})

const toggle = () => screen.getByLabelText('Toggle sessions panel')
const panel = () => screen.queryByLabelText('Sessions')
const dock = () => {
  const el = document.querySelector('.dock')
  if (!el) throw new Error('dock tidak ada')
  return el
}

describe('tombol Sessions di dalam dock', () => {
  it('cuma satu, dan ia tombol dock — bukan plat terapung sendiri', async () => {
    // Dimulai TERTUTUP: justru keadaan itu yang dulu melahirkan pelontar kedua di tepi kiri, jadi
    // guard yang dijalankan dengan panel terbuka akan hijau walau pelontarnya kembali.
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })

    expect(screen.getAllByLabelText('Toggle sessions panel')).toHaveLength(1)
    expect(toggle().closest('.dock')).not.toBeNull()
    // Pelontar lama: satu <div> terapung dengan tombol di dalamnya, diangkur ke tepi kiri yang sama.
    expect(document.querySelector('.sessions-icon-cluster')).toBeNull()
    expect(screen.queryByLabelText('Show sessions')).toBeNull()
  })

  it('klik membuka, klik lagi menutup, dan aria-pressed mengikuti', async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).toBeNull()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).not.toBeNull())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).toBeNull())
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('tombol Hide di panel menutupnya juga', async () => {
    localStorage.setItem(PIN_KEY, '1')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Hide sessions panel'))

    await waitFor(() => expect(panel()).toBeNull())
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('hover di atasnya TIDAK membukanya', async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })

    const btn = toggle()
    fireEvent.mouseEnter(btn)
    fireEvent.mouseOver(btn)

    expect(panel()).toBeNull()
  })
})

describe('pilihan buka/tutup bertahan', () => {
  it("mount dengan '0' tersimpan memulai tertutup, dengan '1' memulai terbuka", async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).toBeNull()

    unmountCanvas()
    localStorage.setItem(PIN_KEY, '1')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).not.toBeNull()
  })

  it('menutup panel menulis pilihannya, dan mount ulang menghormatinya', async () => {
    localStorage.setItem(PIN_KEY, '1')
    await mountCanvas({ nodes: [], dirs: {} })

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).toBeNull())
    expect(localStorage.getItem(PIN_KEY)).toBe('0')

    // Mount ulang TANPA menyentuh storage: yang dibaca adalah apa yang baru saja ditulis.
    unmountCanvas()
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).toBeNull()
  })
})

describe('dock tidak lagi bertumpuk dengan panel', () => {
  it('memakai kelas geser saat panel terbuka, dan melepasnya saat tertutup', async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(dock().classList.contains('dock--shifted')).toBe(false)

    fireEvent.click(toggle())
    await waitFor(() => expect(dock().classList.contains('dock--shifted')).toBe(true))

    fireEvent.click(toggle())
    await waitFor(() => expect(dock().classList.contains('dock--shifted')).toBe(false))
  })

  it('geserannya dibaca dari lebar panel, bukan dari angka kedua yang disalin tangan', () => {
    const dockCss = read('dock.css')
    const panelCss = read('sessions-panel.css')

    // Satu sumber lebar, dipakai kedua sheet.
    expect(panelCss).toContain('--ss-w: 300px')
    expect(panelCss).toContain('width: var(--ss-w)')
    const shifted = dockCss.slice(dockCss.indexOf('.dock--shifted {'))
    expect(shifted).toContain('left: calc(var(--ss-w) + 2 * var(--float-gap))')

    // Bukan diperbaiki lewat z-index: dock di belakang panel = tombolnya tak bisa diklik.
    const plate = dockCss.slice(dockCss.indexOf('.dock {'), dockCss.indexOf('.dock--shifted {'))
    expect(plate).toContain('z-index: 20')
    expect(plate).toContain('transition: left')
    expect(dockCss).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
