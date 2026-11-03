// Satu-satunya setup DOM untuk test canvas webterm: jsdom + React Flow + App yang sungguhan.
//
// KENAPA ADA: 749 test lain berjalan di node-env dan karena itu tidak satu pun bisa mengeksekusi
// jalur "klik file → node editor + kabel penanda". Jalur itu hidup di dalam React Flow, dan React
// Flow MENGUKUR node lewat DOM untuk tahu di mana menggambar edge — tanpa DOM ia tidak pernah
// berjalan, jadi fitur yang hilang di sana tidak membuat satu test pun merah.
//
// KENAPA SATU MODUL: setup di bawah bukan boilerplate, ia tiruan layout. Disalin per file test, dua
// test akan tidak sepakat tentang lingkungannya sendiri dan yang satu "lulus" karena tiruannya
// lebih longgar.
//
// PERINGATAN: lingkungannya jsdom, JANGAN ditukar happy-dom — alasan terukurnya ada di kepala
// `./markdown.test.ts`. Pragma environment ditaruh di FILE TEST, bukan di sini.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
// Elemen `vscode-*` memakai ElementInternals form API yang jsdom belum lengkapi. Satu patch di
// harness ini menutup semua test canvas yang kini merender chrome VS Code (tombol editor, dsb).
import './vscode/test-setup'
import App from './App'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { BridgeLink, Viewport, Workspace, WsNode } from '../shared/workspace'
import type { BrowserStatusResp } from '../shared/browser.contract'
import type { DirEntry } from './fileBrowse'

/** Ukuran pane yang dilaporkan ke React Flow. Angka apa pun yang cukup besar untuk memuat node
 *  fixture; jsdom tidak punya layout, jadi ini satu-satunya sumbernya. */
const PANE = { width: 1280, height: 800 }
/** Fallback saat sebuah elemen tidak punya style width/height (mis. wrapper). 1, bukan 0:
 *  `updateNodeInternals` React Flow membuang pengukuran berukuran nol. */
const MIN_BOX = 1
/** Jeda sesudah pane muncul, untuk menguras timer "siap" React Flow: `onInit` lewat
 *  `setTimeout(…, 1)` dan ResizeObserver tiruan di atas lewat `setTimeout(…, 0)`. Beberapa ms,
 *  bukan nol, supaya keduanya pasti sudah lewat; bukan angka layout, jadi tidak perlu dituning. */
const READY_FLUSH_MS = 5

let domInstalled = false

/**
 * Tambal tiga lubang jsdom yang membuat React Flow mount tapi tidak menggambar apa pun. Idempoten:
 * dipanggil sekali per file test, lewat `beforeAll`.
 *
 * ResizeObserver di sini SENGAJA MENYALA (bukan no-op): di browser, `observe()` langsung mengirim
 * satu entry, dan dari situlah React Flow menghitung `measured` + `handleBounds` tiap node. Stub
 * yang diam membuat node selamanya "belum terukur" — test akan menguji canvas yang tidak pernah
 * ada di browser mana pun.
 */
export function installCanvasDom(): void {
  if (domInstalled) return
  domInstalled = true

  const box = (el: HTMLElement, axis: 'width' | 'height'): number =>
    parseFloat(el.style[axis]) || MIN_BOX

  // Ditulis LANGSUNG ke globalThis, bukan lewat `vi.stubGlobal`: stub global dicabut per test
  // (`unstubAllGlobals`), dan tiruan layout harus berumur sepanjang file — kalau tidak, test kedua
  // dan seterusnya mount canvas di lingkungan yang berbeda dari test pertama.
  const g = globalThis as unknown as Record<string, unknown>

  class FiringResizeObserver implements ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element): void {
      // Asinkron, seperti browser: callback-nya memanggil setState React Flow, dan dari dalam
      // `observe()` yang dipanggil di effect itu jadi tulisan state saat render.
      setTimeout(() => {
        const el = target as HTMLElement
        const rect = { width: box(el, 'width'), height: box(el, 'height') } as DOMRectReadOnly
        this.cb([{ target, contentRect: rect } as ResizeObserverEntry], this)
      }, 0)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  g.ResizeObserver = FiringResizeObserver

  // Dipakai `updateNodeInternals` untuk membaca zoom dari `transform` viewport. Hanya `m22` yang
  // dibaca; 1 = zoom 100%, dan itu memang zoom default fixture.
  class ScaleOnlyMatrix {
    m22 = 1
    constructor(transform?: string) {
      const scale = /scale\(([^)]+)\)/.exec(transform ?? '')
      if (scale) this.m22 = parseFloat(scale[1]) || 1
    }
  }
  g.DOMMatrixReadOnly = ScaleOnlyMatrix

  // Ukuran node: React Flow menulis width/height node sebagai inline style lalu membacanya balik
  // lewat offsetWidth/offsetHeight (`getDimensions` di @xyflow/system). jsdom selalu 0 di sana.
  for (const axis of ['Width', 'Height'] as const) {
    Object.defineProperty(HTMLElement.prototype, `offset${axis}`, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('react-flow')
          ? PANE[axis === 'Width' ? 'width' : 'height']
          : box(this, axis === 'Width' ? 'width' : 'height')
      },
    })
  }

  // Label edge (`EdgeText`) mengukur teksnya sendiri; jsdom tidak mengimplementasikan getBBox.
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 60, height: 12 }),
  })

  // xterm memanggil `matchMedia` saat `term.open()` (melacak perubahan devicePixelRatio); jsdom
  // tidak punya. Tanpa stub ini `term.open` MELEMPAR, dan setiap node terminal/agent mati saat
  // mount — jadi test apa pun yang melahirkan node terminal tidak bisa jalan sama sekali.
  // `matches: false` sudah cukup: yang dipakai hanya pendaftaran listener, bukan jawabannya.
  if (typeof window.matchMedia !== 'function') {
    g.matchMedia = (media: string): MediaQueryList =>
      ({
        media,
        matches: false,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  }
}

export interface CanvasFixture {
  nodes: WsNode[]
  bridges?: BridgeLink[]
  /** Isi tiap direktori yang boleh dibaca node files, per path absolut. */
  dirs: Record<string, DirEntry[]>
  /** Isi tiap file yang boleh dibaca node editor, per path absolut. */
  files?: Record<string, string>
  /** Viewport awal canvas. Default identitas — tapi dengan viewport identitas koordinat layar SAMA
   *  dengan koordinat flow, jadi test yang mau membuktikan sebuah konversi layar→flow benar-benar
   *  terjadi harus menggeser viewport-nya di sini. */
  viewport?: Viewport
  /** Workspace LAIN yang ikut terdaftar (tab kedua dst). Fixture utama tetap yang aktif saat boot;
   *  ini untuk test yang perlu BERPINDAH board. Pakai `harnessWorkspace` untuk membuatnya. */
  others?: Workspace[]
  /** Server TANPA satu pun workspace, yaitu layar `Welcome`. Default: fixture utama selalu ada. */
  blank?: boolean
  /** Tunda tiap respons (ms, timer NYATA). Default 0, yang berarti respons mendarat di microtask
   *  yang sama dengan pemanggilnya — React membatch semuanya dan TIDAK pernah merender di tengah
   *  rantai request. Test yang menguji URUTAN commit wajib memasang tunda: tanpa itu urutan apa pun
   *  menghasilkan render yang sama, dan guard-nya lulus karena jaringannya terlalu cepat. */
  delay?: number
  /** Jawaban `GET /api/browser/status`. Tanpa ini rute itu 404, persis server dengan flag browser mati. */
  browserStatus?: BrowserStatusResp
}

export const HARNESS_WS_ID = 'ws-harness'

/** Workspace lengkap dari beberapa field saja — supaya `others` di atas tidak perlu mengulang
 *  cwd/bridges/updatedAt yang tidak diuji siapa pun. */
export function harnessWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: over.id, cwd: '/', nodes: [], bridges: [], viewport: DEFAULT_VIEWPORT, updatedAt: 0, ...over }
}

function fixtureWorkspace(fx: CanvasFixture): Workspace {
  return {
    id: HARNESS_WS_ID,
    name: 'harness',
    cwd: '/',
    nodes: fx.nodes,
    bridges: fx.bridges ?? [],
    viewport: fx.viewport ?? DEFAULT_VIEWPORT,
    updatedAt: 0,
  }
}

/** Batas I/O yang distub: HANYA `fetch`. Semua keputusan (navigasi, dedupe, pembuatan node & kabel,
 *  persistensi) tetap kode produksi — yang dipalsukan cuma server di ujung kabelnya. */
function routeFetch(fx: CanvasFixture) {
  const ws = fixtureWorkspace(fx)
  const all = fx.blank ? [] : [ws, ...(fx.others ?? [])]
  const reply = (body: unknown) => {
    const res = { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response
    if (!fx.delay) return Promise.resolve(res)
    return new Promise<Response>((r) => setTimeout(() => r(res), fx.delay))
  }

  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname
    const arg = url.searchParams.get('path') ?? ''
    if (path === '/api/settings') return reply(DEFAULT_SETTINGS)
    if (path === '/api/workspaces') return reply(all)
    if (path.startsWith('/api/workspaces/')) {
      // Dicari per id, bukan selalu fixture utama: test pindah-board membaca board KEDUA dari sini,
      // dan rute yang memulangkan board aktif untuk id apa pun akan lulus walau pindahnya tak jalan.
      const id = decodeURIComponent(path.slice('/api/workspaces/'.length))
      return reply(all.find((w) => w.id === id) ?? ws)
    }
    if (path === '/api/browser/status' && fx.browserStatus) return reply(fx.browserStatus)
    if (path === '/api/active') return reply({ id: fx.blank ? null : HARNESS_WS_ID })
    if (path === '/api/fs/list') return reply(fx.dirs[arg] ?? [])
    if (path === '/api/fs/read') return reply({ content: fx.files?.[arg] ?? '' })
    if (path === '/api/fs/exists') return reply({ exists: fx.files?.[arg] !== undefined })
    // Rute tak dikenal TIDAK dijawab 200 kosong: itu menyembunyikan request yang fixture-nya
    // ketinggalan di balik "lulus".
    return Promise.resolve({ ok: false, status: 404, statusText: 'no fixture', json: async () => ({}) } as Response)
  })
}

/**
 * Mount `App` yang SUNGGUHAN di atas satu workspace fixture, dan tunggu sampai canvas-nya hidrat.
 * Bukan tiruan canvas: wiring `onEdgesChange`/`decorateEdges`/`withLinkHandles`/`nodeTypes` yang
 * diuji adalah milik App, jadi harness yang merakit ReactFlow-nya sendiri akan bisa hijau sementara
 * app-nya rusak.
 */
export async function mountCanvas(fx: CanvasFixture): Promise<ReturnType<typeof render>> {
  installCanvasDom()
  vi.stubGlobal('fetch', routeFetch(fx))
  const view = render(<App />)
  await waitFor(() => {
    if (!document.querySelector('.react-flow__pane')) throw new Error('canvas belum hidrat')
  })
  // Pane yang muncul BELUM berarti React Flow siap: `onInit` dipanggil dari dalam sebuah
  // `setTimeout`, jadi `rf.current` App masih null sesaat sesudahnya — dan tanpa instance itu
  // `screenToFlowPosition` tidak ada, sehingga node baru lahir di posisi fallback. Test yang
  // mengklik lebih cepat dari ini menguji canvas yang tidak pernah ada di browser mana pun.
  await act(() => new Promise<void>((r) => setTimeout(r, READY_FLUSH_MS)))
  return view
}

/**
 * Mount `App` dengan SEMUA respons fetch ditahan, dan pulangkan pelepasnya. Satu-satunya cara
 * melihat keadaan "belum tahu": begitu fetch pertama selesai, keadaan itu lewat dalam satu render
 * dan tidak bisa di-assert lagi. Tidak menunggu canvas — yang diuji justru belum adanya canvas.
 */
export function mountHeld(fx: CanvasFixture): () => Promise<void> {
  installCanvasDom()
  const inner = routeFetch(fx)
  let open = (): void => {}
  const gate = new Promise<void>((r) => (open = r))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    await gate
    return inner(input)
  }))
  render(<App />)
  return async () => {
    open()
    // Dua giliran: rantai request boot (`/api/workspaces` → `/api/workspaces/:id`) plus timer
    // "siap" React Flow. Satu `await` saja berhenti di tengah rantai itu.
    await act(() => new Promise<void>((r) => setTimeout(r, READY_FLUSH_MS)))
    await act(() => new Promise<void>((r) => setTimeout(r, READY_FLUSH_MS)))
  }
}

/** Viewport yang BENAR-BENAR terpasang di canvas, dibaca dari `transform` elemen viewport React
 *  Flow — itu yang digambar. State App bisa benar sementara canvas memakai viewport default:
 *  `defaultViewport` hanya dibaca saat mount, jadi bedanya cuma terlihat di DOM. */
export function renderedViewport(): Viewport {
  const el = document.querySelector('.react-flow__viewport')
  const t = (el as HTMLElement | null)?.style.transform ?? ''
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(t)
  if (!m) throw new Error(`viewport tanpa transform terbaca: "${t}"`)
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), zoom: parseFloat(m[3]) }
}

/** Lepas canvas yang ter-mount. WAJIB dipanggil di `afterEach`: auto-cleanup
 *  `@testing-library/react` hanya terpasang kalau ada `afterEach` global, dan vitest webterm
 *  berjalan dengan `globals: false` — tanpa ini App kedua mount di atas yang pertama dan query
 *  `screen` menemukan dua canvas. */
export function unmountCanvas(): void {
  cleanup()
  vi.unstubAllGlobals()
}

/** Semua kabel yang BENAR-BENAR dirender React Flow, sebagai id. Sengaja membaca DOM, bukan state:
 *  kabel yang ada di state tapi dibuang React Flow saat render adalah persis bug yang dicari. */
export function renderedEdgeIds(): string[] {
  return Array.from(document.querySelectorAll('.react-flow__edge')).map(
    (el) => el.getAttribute('data-id') ?? '',
  )
}
