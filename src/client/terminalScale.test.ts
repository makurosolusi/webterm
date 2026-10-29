/**
 * @vitest-environment jsdom
 */
// Dua lapis, sengaja:
//
// 1. MATEMATIKANYA — `unscalePointer` diuji langsung, dengan `rect` yang TIDAK di origin. Kalau
//    rect-nya di (0,0) maka `rect.left + (x - rect.left)/s` menyederhanakan jadi `x/s`, dan bug
//    "lupa menambahkan origin kembali" lulus tanpa terlihat.
//
// 2. INTERNAL XTERM MASIH DI TEMPATNYA — koreksi ini membungkus field privat
//    (`_core._mouseService`, `_core._selectionService`). Kalau versi xterm berikutnya memindahkan
//    atau me-mangle-nya, koreksinya mati TANPA satu pun error di runtime. Lapis kedua ini satu-
//    satunya hal yang akan merah di situ, jadi ia membungkus Terminal SUNGGUHAN dan membuktikan
//    pembungkusnya mengubah hasil — bukan hanya bahwa pemasangannya mengembalikan `true`.
//
// 3. TERSAMBUNG — `TerminalCore` benar-benar memanggil pemasangannya. Lapis 1 dan 2 memanggil
//    `installPointerScaleFix` sendiri, jadi keduanya tetap hijau kalau pemanggilan di produksi
//    dihapus; fitur yang tidak pernah dipasang adalah kegagalan yang paling mudah lolos di sini.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { installPointerScaleFix, unscalePointer } from './terminalScale'
import type { WsNode } from '../shared/workspace'

/** Elemen tiruan: hanya dua hal yang dibaca `unscalePointer`, `getBoundingClientRect` (post-
 *  transform) dan `offsetWidth` (piksel layout). */
function elWith(rect: { left: number; top: number; width: number }, offsetWidth: number): HTMLElement {
  return {
    getBoundingClientRect: () => rect as DOMRect,
    offsetWidth,
  } as unknown as HTMLElement
}

describe('unscalePointer', () => {
  it('memulangkan event YANG SAMA saat tidak ada skala', () => {
    const ev = { clientX: 300, clientY: 200 }
    expect(unscalePointer(ev, elWith({ left: 100, top: 50, width: 800 }, 800))).toBe(ev)
  })

  it('mengabaikan galat pembulatan offsetWidth (zoom 1 pada lebar pecahan)', () => {
    // `offsetWidth` integer, `rect.width` tidak: skala terhitung 1,0005 pada zoom 1,0.
    const ev = { clientX: 300, clientY: 200 }
    expect(unscalePointer(ev, elWith({ left: 0, top: 0, width: 800.4 }, 800))).toBe(ev)
  })

  it('membagi jarak dari tepi elemen pada zoom 2, dengan origin dipertahankan', () => {
    // rect SENGAJA tidak di origin. Pointer 240px (skala) di kanan tepi ⇒ 120px layout.
    const out = unscalePointer({ clientX: 340, clientY: 230 }, elWith({ left: 100, top: 50, width: 1600 }, 800))
    expect(out).toEqual({ clientX: 220, clientY: 140 })
  })

  it('MENGALIKAN jarak pada zoom 0.5', () => {
    const out = unscalePointer({ clientX: 160, clientY: 90 }, elWith({ left: 100, top: 50, width: 400 }, 800))
    expect(out).toEqual({ clientX: 220, clientY: 130 })
  })

  it('tidak menyentuh event saat elemen belum punya layout', () => {
    const ev = { clientX: 300, clientY: 200 }
    // Node collapsed / belum diukur: offsetWidth 0 ⇒ tak ada skala yang bisa diturunkan.
    expect(unscalePointer(ev, elWith({ left: 10, top: 10, width: 800 }, 0))).toBe(ev)
    // rect nol: elemen di-`display: none`.
    expect(unscalePointer(ev, elWith({ left: 10, top: 10, width: 0 }, 800))).toBe(ev)
    // Skala tak finite — tanpa guard ini hasilnya NaN dan seleksi mendarat di sel 1.
    expect(unscalePointer(ev, elWith({ left: 10, top: 10, width: Infinity }, 800))).toBe(ev)
    expect(unscalePointer(ev, elWith({ left: 10, top: 10, width: NaN }, 800))).toBe(ev)
  })
})

// --- lapis 2: Terminal sungguhan -------------------------------------------------------------

/** Lebar sel apa pun yang jelas >1px, supaya pergeseran satu-sel bisa dibedakan dari pembulatan. */
const SCALE = 2

// Dipakai HANYA untuk stub `matchMedia`-nya: xterm memanggilnya di `open()` (melacak perubahan
// devicePixelRatio) dan jsdom tidak punya, jadi tanpa itu `term.open` MELEMPAR dan seluruh lapis
// ini tak bisa jalan. Harness menulisnya langsung ke globalThis, jadi ia selamat dari
// `unstubAllGlobals` di `unmountCanvas` — stub lokal per-file tidak akan.
beforeAll(installCanvasDom)

const hosts: HTMLElement[] = []
const terms: Terminal[] = []

afterEach(() => {
  for (const t of terms.splice(0)) t.dispose()
  for (const h of hosts.splice(0)) h.remove()
  unmountCanvas()
})

function openTerminal(): { term: Terminal; core: Record<string, any> } {
  const host = document.createElement('div')
  host.style.width = '800px'
  host.style.height = '600px'
  document.body.appendChild(host)
  hosts.push(host)
  const term = new Terminal({ cols: 80, rows: 24 })
  terms.push(term)
  term.open(host)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- justru internal privat inilah yang diuji
  return { term, core: (term as any)._core }
}

/** Ukuran sel nyata tidak terukur di jsdom (tak ada layout teks), jadi dimensi render-nya
 *  ditetapkan di sini — inilah pembagi yang dipakai xterm, satuannya CSS px TANPA skala.
 *  `hasValidSize` cuma getter, jadi ia di-shadow lewat defineProperty; tanpa itu `getCoords`
 *  memulangkan `undefined` dan test di bawah membandingkan dua ketiadaan. */
function stubMetrics(mouse: Record<string, any>): void {
  mouse._renderService.dimensions.css.cell = { width: 10, height: 20 }
  mouse._renderService.dimensions.css.canvas = { width: 800, height: 480 }
  Object.defineProperty(mouse._charSizeService, 'hasValidSize', { configurable: true, value: true })
}

/** Buat sebuah elemen melaporkan dirinya ter-skala `SCALE`×: rect post-transform `SCALE` kali lebih
 *  besar dari kotak layout-nya, persis seperti node di dalam `.react-flow__viewport` yang di-zoom. */
function fakeScaled(el: HTMLElement, box: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: box.width })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: box.height })
  el.getBoundingClientRect = () =>
    ({
      left: box.left, top: box.top, right: box.left + box.width * SCALE, bottom: box.top + box.height * SCALE,
      width: box.width * SCALE, height: box.height * SCALE, x: box.left, y: box.top,
    }) as DOMRect
}

describe('installPointerScaleFix di Terminal sungguhan', () => {
  it('internal pointer xterm masih ada di tempat yang dibungkus', () => {
    const { core } = openTerminal()
    expect(typeof core._mouseService?.getCoords).toBe('function')
    expect(typeof core._mouseService?.getMouseReportCoords).toBe('function')
    expect(typeof core._selectionService?._getMouseEventScrollAmount).toBe('function')
    expect(core._selectionService?._screenElement).toBeInstanceOf(HTMLElement)
  })

  it('mengganti kedua method mouse service', () => {
    const { term, core } = openTerminal()
    const before = [core._mouseService.getCoords, core._mouseService.getMouseReportCoords]
    const beforeScroll = core._selectionService._getMouseEventScrollAmount

    expect(installPointerScaleFix(term)).toBe(true)

    expect(core._mouseService.getCoords).not.toBe(before[0])
    expect(core._mouseService.getMouseReportCoords).not.toBe(before[1])
    expect(core._selectionService._getMouseEventScrollAmount).not.toBe(beforeScroll)
  })

  it('memulangkan sel yang BERBEDA dari versi tanpa koreksi saat elemennya ter-skala', () => {
    const { term, core } = openTerminal()
    const mouse = core._mouseService
    stubMetrics(mouse)

    const el = core._selectionService._screenElement as HTMLElement
    fakeScaled(el, { left: 100, top: 50, width: 800, height: 480 })
    // 300px (skala) di bawah tepi atas = 150px layout = baris 8, bukan baris 15.
    const event = { clientX: 100 + 200, clientY: 50 + 300 } as MouseEvent

    const skewed = mouse.getCoords(event, el, 80, 24, true)
    const skewedReport = mouse.getMouseReportCoords(event, el)

    expect(installPointerScaleFix(term)).toBe(true)
    const fixed = mouse.getCoords(event, el, 80, 24, true)
    const fixedReport = mouse.getMouseReportCoords(event, el)

    expect(skewed).toEqual([21, 15])
    expect(fixed).toEqual([11, 8])
    expect(fixed).not.toEqual(skewed)
    expect(skewedReport.row).toBe(15)
    expect(fixedReport.row).toBe(7)
  })

  it('pemasangan kedua TIDAK menumpuk pembagian skalanya', () => {
    const { term, core } = openTerminal()
    const mouse = core._mouseService
    stubMetrics(mouse)
    const el = core._selectionService._screenElement as HTMLElement
    fakeScaled(el, { left: 100, top: 50, width: 800, height: 480 })
    const event = { clientX: 300, clientY: 350 } as MouseEvent

    installPointerScaleFix(term)
    const once = mouse.getCoords(event, el, 80, 24, true)
    const second = mouse.getCoords
    // Dibungkus dua kali, koordinatnya dibagi 4 — lebih buruk dari bug aslinya.
    expect(installPointerScaleFix(term)).toBe(false)
    expect(mouse.getCoords).toBe(second)
    expect(mouse.getCoords(event, el, 80, 24, true)).toEqual(once)
  })

  it('tidak melempar kalau internal xterm hilang, dan melapor di console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(installPointerScaleFix({})).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// --- lapis 3: tersambung ke TerminalCore -----------------------------------------------------

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

describe('TerminalCore', () => {
  it('memasang koreksi ini pada setiap terminal yang dibukanya', async () => {
    // Instance-nya ditangkap dari `open` karena TerminalCore tidak mengeksposnya ke luar.
    const opened: Terminal[] = []
    const open = Terminal.prototype.open
    const spy = vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (this: Terminal, el: HTMLElement) {
      opened.push(this)
      return open.call(this, el)
    })

    await mountCanvas({ nodes: [termNode], dirs: {} })

    expect(opened).not.toHaveLength(0)
    for (const t of opened) {
      // Dibedakan dari "service-nya tidak ada": `false` di bawah hanya boleh berarti SUDAH
      // terpasang, bukan tidak ada apa pun untuk dipasang.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal privat xterm
      expect((t as any)._core._mouseService).toBeTruthy()
      // `false` = instance ini sudah dibungkus. Kalau pemanggilan di TerminalCore dihapus,
      // pemasangan di sini jadi yang PERTAMA dan mengembalikan `true`.
      expect(installPointerScaleFix(t)).toBe(false)
    }
    spy.mockRestore()
  })
})
