/**
 * @vitest-environment jsdom
 */
// Tiga invarian yang semuanya cuma terlihat di DOM: viewport tersimpan yang BENAR-BENAR terpasang
// saat board di-mount, klik minimap, dan gerbang hidrasi.
//
// Dulu file ini menguji dengan MEMBACA source `App.tsx`/`workspaceLifecycle.ts` lalu meregexnya,
// karena belum ada harness DOM. Itu mengunci BENTUK TEKS App: refactor yang perilakunya identik
// bisa memerahkannya, sementara perubahan yang betul-betul membuang viewport tersimpan bisa lolos
// selama teksnya masih cocok. Sekarang lewat `./canvasHarness` — App sungguhan, aksi sungguhan.
//
// Kenapa viewport jadi alat ukurnya: React Flow membaca `defaultViewport` HANYA saat mount, jadi
// satu render dengan board belum lengkap (id benar, viewport masih default) membuang viewport
// tersimpan untuk selamanya — `applyWorkspace` berikutnya tidak me-mount ulang canvas. Jadi
// "viewport yang terpasang == yang tersimpan" adalah pembacaan langsung atas urutan commit-nya.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  HARNESS_WS_ID, harnessWorkspace, installCanvasDom, mountCanvas, mountHeld, renderedViewport, unmountCanvas,
} from './canvasHarness'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Viewport, Workspace } from '../shared/workspace'

/** Dua viewport tersimpan yang BUKAN default dan berbeda satu sama lain — keduanya syarat: dengan
 *  viewport default, test di bawah lulus walau viewport tersimpan dibuang sama sekali. */
const VP_A: Viewport = { x: -300, y: -120, zoom: 0.5 }
const VP_B: Viewport = { x: 410, y: -640, zoom: 1.25 }
const wsB = harnessWorkspace({ id: 'ws-b', name: 'bravo', viewport: VP_B })

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

const tab = (name: string): HTMLElement => {
  const el = screen.getAllByRole('tab').find((t) => t.textContent?.includes(name))
  if (!el) throw new Error(`tab ${name} tidak ada`)
  return el
}

/** Viewport SETELAH animasi `setCenter` (300ms) berhenti. Nilai di tengah animasi bukan hasil yang
 *  diuji: d3 menginterpolasi zoom juga, jadi pembacaan dini melaporkan zoom yang menggoyang. */
async function settledAfter(from: Viewport): Promise<Viewport> {
  let prev = from
  for (let i = 0; i < 30; i++) {
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    const now = renderedViewport()
    if (now.x !== from.x && now.x === prev.x && now.y === prev.y && now.zoom === prev.zoom) return now
    prev = now
  }
  throw new Error('viewport tidak pernah pindah lalu berhenti')
}

/** Viewport di tiap PUT workspace yang benar-benar dikirim ke server. */
const putViewports = (): Viewport[] =>
  (fetch as unknown as Mock).mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT' && String(c[0]).startsWith('/api/workspaces/'))
    .map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as Workspace).viewport ?? DEFAULT_VIEWPORT)

/** Body PUT per id workspace, urut kirim. Id dibaca dari URL-nya, bukan dari body: justru id URL
 *  itulah yang menentukan workspace mana yang tertimpa. */
const putBoards = (): { id: string; ws: Workspace }[] =>
  (fetch as unknown as Mock).mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT' && String(c[0]).startsWith('/api/workspaces/'))
    .map((c) => ({
      id: decodeURIComponent(String(c[0]).slice('/api/workspaces/'.length)),
      ws: JSON.parse(String((c[1] as RequestInit).body)) as Workspace,
    }))

describe('viewport tersimpan terpasang saat board di-mount', () => {
  // `delay` WAJIB di sini, bukan hiasan: dengan fetch yang menjawab di microtask yang sama, React
  // membatch seluruh rantai boot jadi satu render dan urutan commit apa pun lulus. Jaringan yang
  // (sedikit) lambat memberi React kesempatan merender di tengah rantai — persis kondisi yang
  // memunculkan bug ini di browser nyata.
  it('boot memasang viewport workspace aktif, bukan viewport default', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A, others: [wsB], delay: 20 })
    expect(renderedViewport()).toEqual(VP_A)
    expect(VP_A).not.toEqual(DEFAULT_VIEWPORT) // gerbang: fixture-nya memang bukan default
  })

  it('pindah tab memasang viewport workspace TUJUAN', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A, others: [wsB] })
    fireEvent.click(tab('bravo'))
    // Tidak ada jalan pulang dari viewport yang salah: `defaultViewport` sudah terbaca saat mount,
    // jadi kalau render pertama board ini memakai default, nilainya tinggal default selamanya.
    await waitFor(() => expect(renderedViewport()).toEqual(VP_B))
  })

  it('menghapus workspace aktif memasang viewport board penggantinya', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A, others: [wsB] })
    fireEvent.click(screen.getAllByLabelText('Workspace options')[0])
    fireEvent.click(await screen.findByText('Delete'))
    await waitFor(() => expect(renderedViewport()).toEqual(VP_B))
  })
})

describe('klik minimap', () => {
  // Titik klik, koordinat layar. jsdom melaporkan `getBoundingClientRect` di origin, jadi d3
  // memulangkan titik ini apa adanya sebagai titik flow — yang diuji di sini memang bukan
  // konversinya, melainkan apa yang App lakukan dengan titik itu.
  const P1 = { clientX: 120, clientY: 90 }
  const P2 = { clientX: 320, clientY: 250 }

  const minimap = (): Element => {
    const el = document.querySelector('.react-flow__minimap-svg')
    if (!el) throw new Error('minimap tidak dirender')
    return el
  }

  it('memindahkan pandangan ke titik yang diklik, dan zoom berjalan tidak melompat', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A })
    fireEvent.click(minimap(), P1)
    const first = await settledAfter(VP_A)
    fireEvent.click(minimap(), P2)
    const second = await settledAfter(first)

    // `setCenter` tanpa `zoom` jatuh ke maxZoom (2), bukan zoom sekarang: klik cuma boleh
    // memindahkan titik pandang.
    expect(first.zoom).toBe(VP_A.zoom)
    expect(second.zoom).toBe(VP_A.zoom)
    // Geseran pandangan = geseran titik klik × zoom, berlawanan arah. Diuji sebagai SELISIH dua
    // klik supaya tidak bergantung pada ukuran pane tiruan jsdom — dan tetap mati kalau titik
    // kliknya diabaikan, tertukar sumbunya, atau tidak dikalikan zoom.
    expect(second.x - first.x).toBeCloseTo(-(P2.clientX - P1.clientX) * VP_A.zoom)
    expect(second.y - first.y).toBeCloseTo(-(P2.clientY - P1.clientY) * VP_A.zoom)
  })

  it('posisi pandangan yang baru ikut di-persist, bukan cuma terlihat', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A })
    fireEvent.click(minimap(), P1)
    const moved = await settledAfter(VP_A)
    // Debounce `scheduleSave` 400ms, di belakang `syncViewport(320)`.
    await waitFor(() => expect(putViewports().at(-1)).toEqual(moved), { timeout: 2000 })
  })
})

// SATU-SATUNYA penjaga teks yang bertahan di file ini: membuang `syncViewport(320)` dari `onClick`
// minimap TIDAK memerahkan satu test pun (sudah dicoba) — di jsdom `onMoveEnd` React Flow ikut
// memanggil persist untuk perpindahan programatik, jadi PUT-nya tetap mendarat. Panggilan itu jaring
// pengaman eksplisit untuk jalur/browser yang TIDAK mengirim `onMoveEnd`, dan ketiadaannya memang
// tak bisa diamati dari DOM. Jadi bentuk teksnya dijaga, bukan perilakunya.
describe('jaring pengaman persist klik minimap (penjaga teks)', () => {
  it('`onClick` minimap masih memanggil syncViewport', () => {
    // Path disusun dari STRING, bukan `new URL('./App.tsx', import.meta.url)`: `URL` di file jsdom
    // ini milik jsdom, yang mengabaikan base `file://` dan memulangkan `http://localhost/App.tsx`.
    const app = readFileSync(fileURLToPath(import.meta.url).replace(/[^/]+$/, 'App.tsx'), 'utf8')
    const open = app.indexOf('<MiniMap')
    const jsx = app.slice(open, app.indexOf('/>', open))
    expect(open).toBeGreaterThan(-1)
    expect(jsx).toMatch(/syncViewport\(/)
  })
})

// Debounce `scheduleSave` mengunci payload 400ms SEBELUM menulis. Versi lama membaca `nodesRef`/
// `viewportRef` saat timer menembak, jadi pindah tab di dalam jendela itu menulis board workspace B
// ke id workspace A — penghuni workspace A kehilangan board-nya. Diuji lewat body PUT sungguhan:
// yang menentukan rusak-tidaknya data adalah apa yang mendarat di server.
const B_NODE_ID = 'n-b'
const wsBWithNode = harnessWorkspace({
  id: 'ws-b', name: 'bravo', viewport: VP_B,
  nodes: [{ id: B_NODE_ID, kind: 'terminal', x: 40, y: 60, width: 420, height: 320, cwd: '/' }],
})

/** Tambah node lewat Dock: satu-satunya jalur yang memanggil `scheduleSave` secara SINKRON (via
 *  `addFlowNode`), jadi tombol pindah tab berikutnya benar-benar jatuh di dalam debounce 400ms. */
async function addTerminalToActive(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Add node'))
  const item = await waitFor(() => {
    const el = Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((b) => b.textContent?.includes('Terminal'))
    if (!el) throw new Error('item Terminal belum muncul')
    return el as HTMLElement
  })
  fireEvent.click(item)
}

describe('save yang tertunda saat board berpindah', () => {
  it('pindah tab di tengah debounce menulis board A, bukan board B', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A, others: [wsBWithNode] })
    await addTerminalToActive()
    // Pindah SEBELUM 400ms debounce habis — kondisi yang memunculkan bug.
    fireEvent.click(tab('bravo'))
    await waitFor(() => expect(renderedViewport()).toEqual(VP_B))
    // Lewati sisa debounce: timer lama tidak boleh menembak lagi setelah ini.
    await act(() => new Promise<void>((r) => setTimeout(r, 600)))

    const savedA = putBoards().filter((p) => p.id === HARNESS_WS_ID)
    // Save-nya TIDAK boleh hilang: node yang baru dibuat milik board A.
    expect(savedA.length, 'save board A hilang saat pindah tab').toBeGreaterThan(0)
    for (const { ws } of savedA) {
      expect(ws.nodes.map((n) => n.id)).not.toContain(B_NODE_ID)
      expect(ws.viewport).not.toEqual(VP_B)
    }
  })

  it('tanpa pindah tab, save yang sama tetap mendarat dengan board aktif', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A })
    await addTerminalToActive()
    await waitFor(() => {
      if (!putBoards().some((p) => p.id === HARNESS_WS_ID)) throw new Error('PUT belum mendarat')
    }, { timeout: 2000 })

    const saved = putBoards().filter((p) => p.id === HARNESS_WS_ID).at(-1)
    expect(saved?.ws.nodes).toHaveLength(1)
    expect(saved?.ws.nodes[0].kind).toBe('terminal')
    expect(saved?.ws.viewport).toEqual(renderedViewport())
  })

  it('P0: pindah tab menulis board lama TEPAT sekali, membawa node dan viewport-nya', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VP_A, others: [wsBWithNode] })
    await addTerminalToActive()
    // Pindah di tengah debounce: `flushSave` menulis SEKARANG, lalu timer debounce dibatalkan.
    fireEvent.click(tab('bravo'))
    await waitFor(() => expect(renderedViewport()).toEqual(VP_B))
    // Lewati jauh melewati debounce: timer lama tidak boleh menembak PUT kedua.
    await act(() => new Promise<void>((r) => setTimeout(r, 800)))

    const savedA = putBoards().filter((p) => p.id === HARNESS_WS_ID)
    expect(savedA, 'board A harus ditulis sekali saat flush pindah tab').toHaveLength(1)
    expect(savedA[0].ws.nodes).toHaveLength(1)
    expect(savedA[0].ws.nodes[0].kind).toBe('terminal')
    expect(savedA[0].ws.viewport).toEqual(VP_A)
    // Dan tidak ada tulisan susulan yang mencampur board B ke id A.
    for (const { ws } of savedA) {
      expect(ws.nodes.map((n) => n.id)).not.toContain(B_NODE_ID)
      expect(ws.viewport).not.toEqual(VP_B)
    }
  })
})

describe('gerbang hidrasi', () => {
  const dock = () => document.querySelector('.dock')
  const canvas = () => document.querySelector('.react-flow__pane')
  const welcome = () => screen.queryByText(/New project/)

  it('sebelum fetch pertama selesai: tidak ada canvas, tidak ada Welcome, tidak ada dock', async () => {
    const release = mountHeld({ nodes: [], dirs: {}, viewport: VP_A })
    // Tiga keadaan, bukan dua: "belum tahu" tidak boleh dirender sebagai "tidak ada workspace" —
    // itu `Welcome` yang berkelebat sekejap di tiap muat halaman.
    expect(welcome()).toBeNull()
    expect(canvas()).toBeNull()
    expect(dock()).toBeNull()

    await release()
    expect(canvas()).not.toBeNull()
    expect(dock()).not.toBeNull()
    expect(welcome()).toBeNull()
  })

  it('setelah fetch pertama tanpa satu pun workspace: Welcome, dan dock tetap tidak ada', async () => {
    const release = mountHeld({ nodes: [], dirs: {}, blank: true })
    await release()
    expect(welcome()).not.toBeNull()
    // Dock milik board yang ADA: tombolnya menumbuhkan node ke workspace yang belum dibuat.
    expect(dock()).toBeNull()
    expect(canvas()).toBeNull()
  })

  it('header TIDAK ikut digerbang: tombol `+` sudah bisa diklik sebelum fetch pertama selesai', async () => {
    const release = mountHeld({ nodes: [], dirs: {}, blank: true })
    // Satu-satunya jalan masuk selain `Welcome`; header yang baru muncul setelah hidrasi juga
    // menggeser canvas 46px tepat saat pengguna menekan tombolnya.
    expect(screen.queryByLabelText('New workspace')).not.toBeNull()
    await release()
    expect(screen.queryByLabelText('New workspace')).not.toBeNull()
  })
})

// Satu-satunya hal dari versi regex file ini yang TIDAK dipromosikan: `hydrated &&` di gerbang dock.
// Sebabnya ia tak teruji perilaku, bukan terlewat — `workspaces` dan `hydrated` di-commit dalam satu
// render yang sama, jadi tidak ada keadaan di mana `hydrated && !noWorkspaces` berbeda hasil dari
// `!noWorkspaces` saja. Penjaga teksnya tidak dibawa: ia mengunci token yang tak bisa diamati.
// Yang bisa diamati — dock tidak muncul sebelum ada board — dijaga dua test di atas.
