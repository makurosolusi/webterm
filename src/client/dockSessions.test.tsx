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
//   4. Dock DIAM di tepi kiri dan panel yang minggir ke kanannya — bukan sebaliknya.
//
// POSISI PIKSEL TIDAK TERUJI: jsdom tidak punya layout. (4) diuji sebagai keadaan yang bisa diamati
// (kelas plat dock tidak berubah sedikit pun saat panel dibuka) plus penjaga teks CSS di bawah —
// yang membaca bahwa geseran panel memang dihitung dari lebar dock, bukan angka yang disalin tangan.
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

  it('klik membuka, klik lagi menutup, dan aria-current mengikuti', async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).toBeNull()
    // Item activity bar memakai `aria-current="page"` untuk keadaan terpilih, bukan
    // `aria-pressed` — primitifnya memang navigasi, bukan toggle.
    expect(toggle().getAttribute('aria-current')).toBeNull()

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).not.toBeNull())
    expect(toggle().getAttribute('aria-current')).toBe('page')

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).toBeNull())
    expect(toggle().getAttribute('aria-current')).toBeNull()
  })

  it('tombol Hide di panel menutupnya juga', async () => {
    localStorage.setItem(PIN_KEY, '1')
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panel()).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Hide sessions panel'))

    await waitFor(() => expect(panel()).toBeNull())
    expect(toggle().getAttribute('aria-current')).toBeNull()
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

/** Deklarasi `prop` di dalam SATU blok aturan, semuanya. Bukan `toContain`: deklarasi kedua yang
 *  ditambahkan di bawah yang pertama akan lolos `toContain` sementara cascade memakai yang terakhir,
 *  jadi yang dijaga harus "cuma ada satu, dan isinya ini". */
const decls = (css: string, selector: string, prop: string) => {
  const open = css.indexOf(selector)
  if (open < 0) throw new Error(`aturan ${selector} tidak ada`)
  const body = css.slice(open, css.indexOf('}', open))
  return body.match(new RegExp(`${prop}:[^;]*`, 'g')) ?? []
}

describe('dock diam, panel yang minggir', () => {
  it('plat dock tidak berubah sedikit pun saat panel dibuka dan ditutup', async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })
    const before = dock().className

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).not.toBeNull())
    expect(dock().className).toBe(before)

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()).toBeNull())
    expect(dock().className).toBe(before)
  })

  it('panel menempati kolom sidebar di grid, dan rail tetap satu sumber lebar', () => {
    const dockCss = read('dock.css')
    const panelCss = read('sessions-panel.css')
    const shellCss = read('styles.css')

    // Satu sumber lebar rail: diturunkan dari `--activity-bar-w` (48px) milik grid shell, bukan
    // angka mati. Panel memakai token yang sama, jadi rail dan panel tidak bisa bertabrakan.
    const dockW = decls(dockCss, ':root {', '--dock-w')
    expect(dockW).toHaveLength(1)
    expect(dockW[0]).toBe('--dock-w: var(--activity-bar-w)')

    // Panel adalah KOLOM grid, bukan kartu absolut: `left`/`top` kembali `auto` dan lebarnya
    // ditentukan `.app-shell--sidebar` (300px). Rail tidak pernah bergeser karenanya.
    expect(decls(panelCss, '.sessions-sidebar {', 'grid-area')).toEqual(['grid-area: sidebar'])
    expect(decls(panelCss, '.sessions-sidebar {', 'left')).toEqual(['left: auto'])
    expect(decls(panelCss, '.sessions-sidebar {', 'top')).toEqual(['top: auto'])
    expect(decls(panelCss, '.sessions-sidebar {', 'width')).toEqual(['width: 100%'])
    expect(panelCss).toContain('--ss-w: 300px')
    const open = shellCss.slice(shellCss.indexOf('.app-shell--sidebar {'))
    expect(open.slice(0, open.indexOf('}'))).toContain('300px')

    // Rail adalah grid item, bukan plat absolut yang bisa bergeser.
    expect(decls(dockCss, '.dock {', 'grid-area')).toEqual(['grid-area: activity'])
    expect(dockCss).not.toContain('left: var(--float-gap)')
    expect(dockCss).not.toContain('dock--shifted')
    expect(dockCss).not.toContain('transition: left')
  })

  it('Add dialog opens above the panel', async () => {
    localStorage.setItem(PIN_KEY, '0')
    await mountCanvas({ nodes: [], dirs: {} })

    fireEvent.click(screen.getByLabelText('Add node'))
    const dialog = await waitFor(() => {
      const el = document.querySelector('[data-slot="vscode-quick-pick"]')
      if (!el) throw new Error('quick pick belum muncul')
      return el
    })
    expect(dialog.textContent).toContain('Terminal')

    // Panel kini KOLOM grid di samping rail, bukan kartu absolut yang bertumpuk — tidak ada lagi
    // kompetisi z-index di antara keduanya. Rail tetap memakai z-index 20 supaya menu/dialog di
    // atasnya tidak tertutup oleh permukaan yang mengapung.
    const dockCss = read('dock.css')
    expect(decls(dockCss, '.dock {', 'z-index')).toEqual(['z-index: 20'])
  })
})
