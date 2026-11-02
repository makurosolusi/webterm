/**
 * @vitest-environment jsdom
 */
// Split pane node terminal, diuji di canvas SUNGGUHAN (pola yang sama dengan
// `terminalNodeMenu.test.tsx`).
//
// KENAPA DI SINI, bukan cuma di `paneTree.test.ts`: model pohonnya murni dan sudah diuji di
// node-env, tapi yang diminta pengguna adalah DUA TERMINAL DI SATU NODE. Yang bisa salah tanpa
// membuat satu test model pun merah: pohonnya benar tapi tidak pernah dirender, pane barunya lahir
// tanpa PTY, bentuknya tidak ikut tersimpan, atau menutup node hanya mematikan satu shell dari empat.
import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas, HARNESS_WS_ID } from './canvasHarness'
import type { WsNode } from '../shared/workspace'

// `send` dicatat, SISA modulnya asli: `subscribe`/`subscribeStatus` tetap kode produksi, jadi
// terminal tiap pane benar-benar lahir seperti di browser. Mengganti seluruh modul akan membuat
// "pane baru dapat terminal sendiri" tak bisa dibuktikan di sini.
const { sent } = vi.hoisted(() => ({ sent: [] as { t: string; id: string }[] }))
vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: (m: { t: string; id: string }) => { sent.push(m) } }
})

/** Lebih lama dari debounce 400ms `scheduleSave` di App. */
const SAVE_FLUSH_MS = 480

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

const paneIds = (): string[] =>
  Array.from(document.querySelectorAll('[data-pane-id]')).map((el) => el.getAttribute('data-pane-id') ?? '')

const paneEl = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-pane-id="${id}"]`)
  if (!el) throw new Error(`pane "${id}" tidak dirender (yang ada: ${paneIds().join(', ')})`)
  return el as HTMLElement
}

const headerBtn = (title: string): HTMLButtonElement => {
  // Aksi toolbar kini `vscode-toolbar-button` (tombol aslinya di shadow DOM); tombol Split masih
  // shadcn `Button` di `extraHeader`, jadi kedua bentuk dicari. `title` pada custom element tidak
  // diterapkan di jsdom (lit wrapper node-build), jadi toolbar juga membawa `data-title`.
  const el = document.querySelector(
    `.react-flow__node-terminal button[title="${title}"], .react-flow__node-terminal vscode-toolbar-button[data-title="${title}"]`,
  )
  if (!el) throw new Error(`tombol header "${title}" tidak ada`)
  return el as HTMLButtonElement
}

const nodeMenu = (): HTMLElement | null =>
  document.querySelector('[role="menu"][data-slot="vscode-menu"]')

const menuRow = (label: string): HTMLButtonElement => {
  const el = Array.from(nodeMenu()?.querySelectorAll('button') ?? []).find((b) => b.textContent === label)
  if (!el) throw new Error(`baris "${label}" tidak ada di menu`)
  return el as HTMLButtonElement
}

/** Klik kanan DI DALAM satu pane, seperti pengguna: pane sasaran menu diambil dari target event,
 *  jadi menu untuk pane lain adalah bug yang hanya terlihat lewat jalur ini. */
async function openMenuOn(pane: string): Promise<void> {
  fireEvent(paneEl(pane), new MouseEvent('contextmenu', {
    clientX: 300, clientY: 220, bubbles: true, cancelable: true,
  }))
  await waitFor(() => expect(nodeMenu()).not.toBeNull())
}

const paneHost = (): HTMLElement => {
  const el = document.querySelector('.pane-host')
  if (!el) throw new Error('badan pane tidak dirender')
  return el as HTMLElement
}

/** Kotak sebuah pane seperti yang BENAR-BENAR dipasang ke layout. Inilah arah DAN rasionya: kelas
 *  CSS bisa benar sementara pane-nya menumpuk di tempat yang sama. */
const rect = (id: string): string =>
  ['left', 'top', 'width', 'height'].map((k) => paneEl(id).style[k as 'left']).join(' ')

/** Sumbu tiap pembatas, urut dari akar. 'vertical' = batas tegak = split berdampingan. */
const orientations = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.pane-divider')).map((d) => d.getAttribute('aria-orientation'))

const divider = (path = ''): HTMLElement => {
  const el = document.querySelector(`.pane-divider[data-pane-path="${path}"]`)
  if (!el) throw new Error(`pembatas cabang "${path}" tidak ada`)
  return el as HTMLElement
}

/** Rect host yang dipalsukan: jsdom tidak punya layout, jadi tanpa ini `ratioFromPointer` melihat
 *  span 0 dan SELALU memulangkan 0.5 — test geser akan "lulus" tanpa menggerakkan apa pun. */
function stubHostRect(): HTMLElement {
  const host = paneHost()
  host.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200 }) as DOMRect
  return host
}

/** Body PUT terakhir ke workspace fixture — bentuk yang BENAR-BENAR dipersist. */
function savedNodes(): WsNode[] {
  const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls
  const put = calls.filter(([url, init]) =>
    String(url) === `/api/workspaces/${HARNESS_WS_ID}` && init?.method === 'PUT')
  if (put.length === 0) throw new Error('belum ada PUT workspace')
  return JSON.parse(String(put[put.length - 1][1]?.body)).nodes as WsNode[]
}

/** Satu split lewat menu konteks node (baris Split right/down), ditunggu sampai pane barunya ada di DOM.
 *  Klik kanan di `.node-body` (bukan di dalam pane) → sasarannya pane aktif, seperti tombol header dulu. */
async function splitVia(title: 'Split right' | 'Split down'): Promise<void> {
  const before = paneIds().length
  const body = document.querySelector('.react-flow__node-terminal .node-body') as HTMLElement
  fireEvent.contextMenu(body)
  const row = Array.from(document.querySelectorAll('[role="menu"][data-slot="vscode-menu"] button')).find(
    (b) => b.textContent === title,
  )
  if (!row) throw new Error(`baris menu "${title}" tidak ada`)
  fireEvent.click(row)
  await waitFor(() => expect(paneIds()).toHaveLength(before + 1))
}

// jsdom tidak punya layout: tanpa ini host terminal 0x0 dan `open` ditunda sampai fallback waktu.
// Hanya host terminal (kelas `nowheel`) yang diberi ukuran, supaya ukuran React Flow tak berubah.
function sizeTerminalHosts(): void {
  for (const dim of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, dim, {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('nowheel') ? 400 : 0 },
    })
  }
}

beforeAll(() => { installCanvasDom(); sizeTerminalHosts() })
afterEach(() => {
  unmountCanvas()
  vi.restoreAllMocks()
  sent.length = 0
})

describe('split pane node terminal', () => {
  it('node tanpa panes tetap SATU terminal ber-id node — board lama tidak berubah', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })

    expect(paneIds()).toEqual(['term-1'])
    expect(rect('term-1')).toBe('0% 0% 100% 100%')
    expect(orientations()).toEqual([])
    // Satu terminal xterm yang sungguhan, dan PTY-nya dibuka dengan id node.
    expect(document.querySelectorAll('.xterm')).toHaveLength(1)
    expect(sent.filter((m) => m.t === 'open').map((m) => m.id)).toEqual(['term-1'])
  })

  it('Split right memberi pane baru TERMINAL dan PTY-nya sendiri, berdampingan', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    sent.length = 0

    await splitVia('Split right')

    expect(paneIds()).toEqual(['term-1', 'term-1:p2'])
    // Arah split ada di GEOMETRI: separuh lebar, tinggi penuh. Tanpa ini, split yang selalu
    // bertumpuk tetap lulus karena jumlah pane-nya sama.
    expect(rect('term-1')).toBe('0% 0% 50% 100%')
    expect(rect('term-1:p2')).toBe('50% 0% 50% 100%')
    expect(orientations()).toEqual(['vertical'])
    expect(document.querySelectorAll('.xterm')).toHaveLength(2)
    // PTY BARU, bukan terminal kedua yang menempel ke sesi yang sama.
    expect(sent.filter((m) => m.t === 'open').map((m) => m.id)).toEqual(['term-1:p2'])
    // Shell lama tidak tersentuh: tidak ada satu pun `close` saat membelah.
    expect(sent.filter((m) => m.t === 'close')).toEqual([])
  })

  it('terminal yang sudah ada BERTAHAN melewati split, bukan dibuat ulang', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    const before = paneEl('term-1').querySelector('.xterm')
    expect(before).not.toBeNull()
    sent.length = 0

    await splitVia('Split right')
    await splitVia('Split down')

    // Elemen xterm yang SAMA, bukan yang baru: layout bersarang membuat tiap split memindahkan
    // daun satu tingkat lebih dalam, dan React membuang komponen yang berpindah posisi — seleksi,
    // pencarian dan posisi scroll tiap pane hilang pada setiap split.
    expect(paneEl('term-1').querySelector('.xterm')).toBe(before)
    // Dan karena tidak ada yang di-mount ulang, tidak ada `open` ulang untuk sesi lama.
    expect(sent.filter((m) => m.t === 'open').map((m) => m.id)).toEqual(['term-1:p2', 'term-1:p3'])
  })

  it('Split down membelah bertumpuk', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })

    await splitVia('Split down')

    expect(rect('term-1')).toBe('0% 0% 100% 50%')
    expect(rect('term-1:p2')).toBe('0% 50% 100% 50%')
    expect(orientations()).toEqual(['horizontal'])
  })

  it('split berulang menyusun 2×2 seperti yang diminta, empat terminal di satu node', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })

    await splitVia('Split right') // h(term-1, p2) — p2 jadi aktif
    await splitVia('Split down')  // h(term-1, v(p2, p3))
    // Klik di pane kiri memindahkan fokus ke sana, jadi split berikutnya membelah SISI ITU.
    fireEvent.pointerDown(paneEl('term-1'))
    await splitVia('Split down')  // h(v(term-1, p4), v(p2, p3)) = 2×2

    expect(paneIds()).toEqual(['term-1', 'term-1:p4', 'term-1:p2', 'term-1:p3'])
    // Empat kuadran yang benar-benar menutup badan node tanpa saling menimpa — itulah 2×2 di
    // screenshot, dan daftar pane datar tidak bisa menyatakannya.
    expect(rect('term-1')).toBe('0% 0% 50% 50%')
    expect(rect('term-1:p4')).toBe('0% 50% 50% 50%')
    expect(rect('term-1:p2')).toBe('50% 0% 50% 50%')
    expect(rect('term-1:p3')).toBe('50% 50% 50% 50%')
    // Satu pembatas tegak di tengah, lalu satu pembatas datar di MASING-MASING kolom: split di
    // dalam split, bukan satu pembatas datar yang membelah seluruh node.
    expect(orientations()).toEqual(['vertical', 'horizontal', 'horizontal'])
    expect(document.querySelectorAll('.xterm')).toHaveLength(4)
  })

  it('bentuk split IKUT TERSIMPAN, jadi board 2×2 bertahan lintas reload', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await splitVia('Split right')
    await splitVia('Split down')

    await act(() => new Promise<void>((r) => setTimeout(r, SAVE_FLUSH_MS)))

    // Pohon bersarang yang persis, bukan cuma "ada field panes": `toWsNode` yang menjatuhkan
    // `panes` membuat setiap split hilang saat reload.
    expect(savedNodes()[0].panes).toEqual({
      dir: 'h',
      ratio: 0.5,
      a: { id: 'term-1' },
      b: { dir: 'v', ratio: 0.5, a: { id: 'term-1:p2' }, b: { id: 'term-1:p3' } },
    })
  })

  it('board tersimpan yang sudah terbelah dipasang kembali apa adanya', async () => {
    await mountCanvas({
      nodes: [{ ...termNode, panes: { dir: 'v', ratio: 0.3, a: { id: 'term-1' }, b: { id: 'term-1:p2' } } }],
      dirs: {},
    })

    expect(paneIds()).toEqual(['term-1', 'term-1:p2'])
    expect(orientations()).toEqual(['horizontal'])
    // Rasio tersimpan dipakai, bukan direset ke 0.5.
    expect(rect('term-1')).toBe('0% 0% 100% 30%')
    expect(rect('term-1:p2')).toBe('0% 30% 100% 70%')
  })

  it('Close pane mematikan HANYA shell pane itu, dan pohonnya kempis', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await splitVia('Split right')
    sent.length = 0

    await openMenuOn('term-1:p2')
    fireEvent.click(menuRow('Close pane'))

    await waitFor(() => expect(paneIds()).toEqual(['term-1']))
    // Satu `close`, untuk pane yang diklik — bukan untuk id node, bukan untuk keduanya.
    expect(sent.filter((m) => m.t === 'close')).toEqual([{ t: 'close', id: 'term-1:p2' }])
    // Kempis: pembatasnya hilang dan pane sisanya mengambil KEMBALI seluruh ruang. Tanpa
    // pengempisan ia akan tetap duduk di separuh node dengan separuh lainnya kosong.
    expect(orientations()).toEqual([])
    expect(rect('term-1')).toBe('0% 0% 100% 100%')
    expect(document.querySelectorAll('.xterm')).toHaveLength(1)
  })

  it('menu konteks menyasar pane YANG DIKLIK, bukan pane aktif', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await splitVia('Split right') // p2 yang aktif sekarang
    sent.length = 0

    // Diklik kanan pane KIRI; kalau menu memakai pane aktif, yang mati adalah terminal yang salah.
    await openMenuOn('term-1')
    fireEvent.click(menuRow('Close pane'))

    await waitFor(() => expect(paneIds()).toEqual(['term-1:p2']))
    expect(sent.filter((m) => m.t === 'close')).toEqual([{ t: 'close', id: 'term-1' }])
  })

  it('menutup pane TERAKHIR menutup nodenya, lewat jalur close node yang biasa', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    sent.length = 0

    await openMenuOn('term-1')
    fireEvent.click(menuRow('Close pane'))

    await waitFor(() => expect(document.querySelector('.react-flow__node-terminal')).toBeNull())
    // Satu `close` saja: dirutekan ke `deleteElements`, bukan dikirim di sini LALU sekali lagi di App.
    expect(sent.filter((m) => m.t === 'close')).toEqual([{ t: 'close', id: 'term-1' }])
  })

  it('menutup NODE yang terbelah mematikan SEMUA PTY-nya, bukan cuma id node', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await splitVia('Split right')
    await splitVia('Split down')
    sent.length = 0

    fireEvent.click(headerBtn('Close (ends the session)'))

    await waitFor(() => expect(document.querySelector('.react-flow__node-terminal')).toBeNull())
    // Inilah kebocorannya: dulu hanya `term-1` yang dikirim dan dua shell sisanya hidup tanpa
    // pemilik sampai server restart.
    expect(sent.filter((m) => m.t === 'close').map((m) => m.id).sort())
      .toEqual(['term-1', 'term-1:p2', 'term-1:p3'])
  })

  it('menggeser pembatas mengubah rasio pane, pada sumbu arah split-nya', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await splitVia('Split right')

    stubHostRect()
    const bar = divider()
    fireEvent.pointerDown(bar, { pointerId: 1, clientX: 300, clientY: 150 })
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 200, clientY: 150 })

    // x=200 di dalam rect yang mulai di 100 dan lebar 400 → seperempat untuk sisi kiri.
    await waitFor(() => expect(rect('term-1')).toBe('0% 0% 25% 100%'))
    expect(rect('term-1:p2')).toBe('25% 0% 75% 100%')

    fireEvent.pointerUp(bar, { pointerId: 1 })
    // Lepas = berhenti mendengar: gerakan sesudahnya tidak boleh menggeser apa pun lagi.
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 380, clientY: 150 })
    expect(rect('term-1')).toBe('0% 0% 25% 100%')
  })

  it('pembatas DI DALAM split memakai rentang cabangnya sendiri, bukan seluruh node', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    // Dua split pada sumbu YANG SAMA. Itu syaratnya: pembatas bersarang yang sumbunya BERBEDA dari
    // split luarnya ('v' di dalam 'h') membaca rentang yang kebetulan identik dengan rentang seluruh
    // node, jadi rect host yang salah pun lolos di sana. Di sini cabang 'b' cuma menempati x 300..500
    // dari host 100..500, sehingga rentang yang salah langsung terbaca di hasilnya.
    await splitVia('Split right') // h(term-1, p2), p2 aktif
    await splitVia('Split right') // h(term-1, h(p2, p3)) — cabang 'b' = paruh KANAN saja
    stubHostRect()

    const bar = divider('b')
    fireEvent.pointerDown(bar, { pointerId: 1, clientX: 450, clientY: 150 })
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 150 })

    // x=400 adalah TENGAH cabang kanan (0.5 → 25% + 25%). Terhadap seluruh node ia 0.75, yang akan
    // memberi p2 lebar 37.5% — itulah bedanya.
    await waitFor(() => expect(rect('term-1:p2')).toBe('50% 0% 25% 100%'))
    expect(rect('term-1:p3')).toBe('75% 0% 25% 100%')
    expect(rect('term-1')).toBe('0% 0% 50% 100%')
  })

  it('pembatas tidak menggeser canvas dan rasio hasil geseran ikut tersimpan', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await splitVia('Split down')

    stubHostRect()
    const bar = divider()
    // `nodrag`/`nopan` dicocokkan React Flow lewat `closest()`, jadi kelasnya BAGIAN DARI kontrak:
    // tanpa itu menggeser pembatas malah menggeser nodenya.
    expect(bar.className).toContain('nodrag')
    expect(bar.className).toContain('nopan')

    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    fireEvent(bar, down)
    expect(down.defaultPrevented).toBe(true)

    // y=90 di dalam rect yang mulai di 50 dan tinggi 200 → 0.2 untuk sisi atas.
    fireEvent.pointerMove(bar, { clientX: 0, clientY: 90 })
    await waitFor(() => expect(rect('term-1')).toBe('0% 0% 100% 20%'))
    fireEvent.pointerUp(bar)

    await act(() => new Promise<void>((r) => setTimeout(r, SAVE_FLUSH_MS)))
    expect(savedNodes()[0].panes).toEqual({
      dir: 'v', ratio: 0.2, a: { id: 'term-1' }, b: { id: 'term-1:p2' },
    })
  })
})
