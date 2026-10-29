// Koreksi koordinat pointer xterm untuk canvas yang di-zoom.
//
// KENAPA ADA: xterm memetakan pointer ke sel lewat `getCoordsRelativeToElement`
// (node_modules/@xterm/xterm/src/browser/input/Mouse.ts), yang menghitung
// `event.clientX - element.getBoundingClientRect().left`. Keduanya piksel VIEWPORT, jadi
// selisihnya adalah jarak SESUDAH transform CSS leluhur. Hasilnya lalu dibagi
// `_renderService.dimensions.css.cell.{width,height}` — ukuran sel dalam CSS px TANPA skala. Jadi
// sel yang dilaporkan = sel sebenarnya × skala: pada zoom 1.5 seleksi mendarat di bawah/kanan
// pointer, pada zoom 0.7 di atas/kiri, dan pada zoom tepat 1.0 galatnya nol (itulah sebabnya bug
// ini tidak pernah terlihat saat canvas belum disentuh). React Flow memasang
// `transform: translate(...) scale(zoom)` pada `.react-flow__viewport` dan setiap node ada di
// dalamnya, jadi SEMUA terminal webterm terkena. Bandingkan xtermjs/xterm.js#2488.
//
// Pembaginya memang tanpa skala, sudah dicek di xterm 6.0.0: `CharSizeService` mengukur sel lewat
// `OffscreenCanvas.measureText` (metrik font murni) atau `offsetWidth` (piksel layout) — tidak ada
// jalur yang melewati `getBoundingClientRect`. Jadi di sini TIDAK ada risiko koreksi ganda: hanya
// satu dari dua sisi pembagian yang ter-skala, dan itulah sisi yang dikoreksi di bawah.
//
// xterm tidak punya API untuk memberi tahu skala leluhur, jadi koreksinya dipasang dari luar: tiga
// seam internal dibungkus, dan masing-masing menerima event palsu yang `clientX`/`clientY`-nya
// sudah di-"unscale" lebih dulu. Mengoreksi MASUKAN, bukan keluaran, penting — xterm juga
// mengurangi `padding-left`/`padding-top` dari computed style, yang satuannya CSS px tanpa skala,
// jadi pengurangan itu baru benar setelah jaraknya ikut tanpa skala.
//
// Modul sendiri, bukan tambahan ke `terminalKeys.ts`: file itu sudah 19.6k karakter dari batas 20k.

/** Di bawah ambang ini skala dianggap 1 dan event dipulangkan apa adanya. Ambangnya ADA karena
 *  `offsetWidth` dibulatkan ke integer sementara `rect.width` tidak: pada zoom 1.0 sebuah elemen
 *  selebar 800,4px menghasilkan skala 800,4/800 = 1,0005. Tanpa ambang, setiap terminal pada zoom
 *  normal akan melewati jalur koreksi dan mengganti koordinat bulat dengan koordinat pecahan tanpa
 *  satu pun alasan. Nilainya bukan tuning per-environment: ia cuma lebih besar dari galat
 *  pembulatan satu piksel pada elemen selebar beberapa ratus piksel. */
const SCALE_EPSILON = 0.001

/** Koordinat pointer dalam piksel viewport — HANYA dua field ini yang dibaca xterm dari event
 *  mouse-nya, jadi event palsu sekecil ini cukup. Dan ia memang harus sekecil ini: `{...event}`
 *  tidak mengkopi apa pun (semua field `MouseEvent` adalah getter di prototype), sementara
 *  `Object.create(event)` membuat getter native itu melempar "Illegal invocation" karena
 *  receiver-nya bukan MouseEvent sungguhan. */
export interface PointerCoords {
  clientX: number
  clientY: number
}

/**
 * Pulangkan koordinat pointer seolah `el` tidak ter-skala: titik yang sama, tapi jaraknya dari
 * tepi `el` diukur dalam piksel LAYOUT, satuan yang dipakai xterm untuk ukuran selnya.
 *
 * Skala diturunkan dari elemennya sendiri (`rect.width / el.offsetWidth`), bukan dibaca dari zoom
 * React Flow: modul ini tidak boleh kenal canvas, dan zoom bisa berubah di antara dua event — jadi
 * ia dihitung ulang per event, bukan di-cache.
 *
 * Mengembalikan `event` yang SAMA (tanpa alokasi) kalau tidak ada yang perlu dikoreksi.
 */
export function unscalePointer<T extends PointerCoords>(event: T, el: HTMLElement): T | PointerCoords {
  const rect = el.getBoundingClientRect()
  const layoutWidth = el.offsetWidth
  // Nol/NaN di salah satu sisi = elemen belum punya layout (node collapsed 0×0, atau jsdom tanpa
  // stub ukuran). Tidak ada skala yang bisa diturunkan; biarkan xterm menghitung seperti biasa.
  if (!layoutWidth || !rect.width) return event
  const scale = rect.width / layoutWidth
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < SCALE_EPSILON) return event
  return {
    clientX: rect.left + (event.clientX - rect.left) / scale,
    clientY: rect.top + (event.clientY - rect.top) / scale,
  }
}

interface MouseServiceLike {
  getCoords(
    event: PointerCoords,
    element: HTMLElement,
    colCount: number,
    rowCount: number,
    isSelection?: boolean,
  ): [number, number] | undefined
  getMouseReportCoords(event: MouseEvent, element: HTMLElement): unknown
}

interface SelectionServiceLike {
  _screenElement?: HTMLElement
  _getMouseEventScrollAmount?(event: MouseEvent): number
}

interface XtermCore {
  _mouseService?: MouseServiceLike
  _selectionService?: SelectionServiceLike
}

/** Instance yang sudah dibungkus. Pembungkusan BERTUMPUK membagi koordinat dengan skala dua kali,
 *  yang lebih buruk daripada bug aslinya — dan karena pemasangan tidak pernah dilepas (lihat
 *  `installPointerScaleFix`), satu penanda per instance adalah satu-satunya penjaganya. */
const patched = new WeakSet<object>()

/**
 * Pasang koreksi skala pada satu terminal. Panggil SESUDAH `term.open(el)`: service yang dibungkus
 * di bawah baru dibuat di dalam `open()` (CoreBrowserTerminal.ts:488/518), jadi sebelum itu tidak
 * ada apa pun untuk dibungkus.
 *
 * SENGAJA tidak mengembalikan pelepas. Pemasangan ini hidup selama terminalnya: begitu ia bisa
 * dilepas per-effect, remount berikutnya akan membungkus instance yang sama dua kali, dan cleanup
 * yang satu akan mencabut koreksi yang masih dipakai. Terminal yang di-dispose membawa service-nya
 * sendiri pergi, jadi tidak ada yang bocor.
 *
 * @returns `true` kalau koreksi baru terpasang, `false` kalau terminal ini sudah terpasang atau
 *          internal xterm yang dibutuhkan tidak ada.
 */
export function installPointerScaleFix(term: object): boolean {
  const core = (term as { _core?: XtermCore })._core
  const mouse = core?._mouseService
  if (!mouse) {
    // Bergantung pada internal privat xterm: kalau versi berikutnya memindahkannya, koreksinya mati
    // TANPA error. Jejak di console adalah satu-satunya tanda di runtime (test
    // `terminalScale.test.ts` adalah tanda di CI).
    console.warn('terminal: xterm mouse service unavailable, pointer coords stay zoom-skewed')
    return false
  }
  if (patched.has(mouse)) return false
  patched.add(mouse)

  // 1 & 2: seluruh pemetaan pointer→sel lewat sini — seleksi (SelectionService.ts:398, :710),
  // hover link (Linkifier.ts:382), dan mouse report ke TUI (CoreBrowserTerminal.ts:609).
  const getCoords = mouse.getCoords.bind(mouse)
  mouse.getCoords = (event, element, colCount, rowCount, isSelection) =>
    getCoords(unscalePointer(event, element), element, colCount, rowCount, isSelection)

  const getMouseReportCoords = mouse.getMouseReportCoords.bind(mouse)
  mouse.getMouseReportCoords = (event, element) =>
    getMouseReportCoords(unscalePointer(event, element) as MouseEvent, element)

  // 3: auto-scroll saat drag seleksi melewati tepi. Ia memanggil `getCoordsRelativeToElement`
  // LANGSUNG, bukan lewat mouse service, jadi dua wrapper di atas tidak menyentuhnya — tanpa ini,
  // pada zoom 1.5 scroll mulai sepertiga di atas tepi bawah. Method privat di prototype; properti
  // instance menaunginya.
  const sel = core?._selectionService
  const screen = sel?._screenElement
  if (sel?._getMouseEventScrollAmount && screen) {
    const scrollAmount = sel._getMouseEventScrollAmount.bind(sel)
    sel._getMouseEventScrollAmount = (event) =>
      scrollAmount(unscalePointer(event, screen) as MouseEvent)
  } else {
    console.warn('terminal: xterm selection drag-scroll internals unavailable, left zoom-skewed')
  }

  return true
}
