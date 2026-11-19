/**
 * @vitest-environment jsdom
 */
// Menu konteks canvas, diuji di canvas SUNGGUHAN. Yang diuji di sini sengaja hanya hal-hal yang
// tidak bisa dijangkau 35 test murni di `canvasMenu.model.test.ts` / `canvasMenu.geometry.test.ts`:
// bukan ISI menunya, melainkan apakah ia tersambung sama sekali.
//
// Sebabnya ada: menu ini pernah LENGKAP dan HIJAU di level unit sementara tidak ada satu pun file
// yang meng-import-nya — fiturnya mati total dan tak ada satu test pun yang merah. Jarak antara
// "komponennya benar" dan "klik kanan memunculkannya" cuma bisa dijembatani DOM; lihat
// `./canvasHarness.tsx`.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { MENU_LABELS } from './canvasMenu.model'
// The Layers side bar's empty state offers the same "New Terminal" / "New Agent" buttons as the
// canvas menu; these queries mean the menu row, so the side bar is left out.
const OUTSIDE_SIDE_BAR = { ignore: 'script, style, .sessions-sidebar *' }
import type { WsNode } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'

// Titik klik kanan, dalam koordinat LAYAR.
const CLICK = { clientX: 520, clientY: 330 }

/** Canvas yang SUDAH DIGESER. Penting, bukan hiasan: dengan viewport identitas koordinat layar sama
 *  dengan koordinat flow, jadi test posisi di bawah akan tetap hijau walau `screenToFlowPosition`
 *  dihapus sama sekali. Digeser begini, titik flow-nya berbeda dari titik layarnya. Zoom dibiarkan
 *  1 — pengukuran node di jsdom bergantung padanya, dan pergeseran saja sudah membuktikan konversi. */
const PANNED = { x: -140, y: -70, zoom: 1 }

/** Posisi spawn DEFAULT (tengah pandangan) untuk node pertama, dari `spawnAt`+`spawnPosition`:
 *  jsdom melaporkan window 1024×768, jadi tengahnya (512,384) dikurangi separuh ukuran node.
 *  Dibawa sebagai konstanta supaya terbukti test di bawah membedakan "di titik klik" dari "di
 *  tempat biasa" — bukan hijau karena kebetulan keduanya berdekatan. */
const DEFAULT_SPAWN = {
  x: window.innerWidth / 2 - DEFAULT_SETTINGS.defaultNodeWidth / 2,
  y: window.innerHeight / 2 - DEFAULT_SETTINGS.defaultNodeHeight / 2,
}

/** Di mana node seharusnya lahir saat dibuat dari menu pada canvas `PANNED`: titik klik dikonversi
 *  ke koordinat flow lebih dulu, lalu DIPUSATKAN di situ — aturan yang sama dengan spawn biasa yang
 *  dipusatkan di tengah pandangan. (`getBoundingClientRect` jsdom selalu di origin, jadi konversinya
 *  cuma soal viewport.) */
/** Claude-first: the `New agent ▸` submenu holds custom agents only, so submenu tests seed one. */
const WITH_CUSTOM = { settings: { customAgents: [{ id: 'custom:a1', label: 'My Proxy', launchCmd: 'proxy' }] } }

const AT_CLICK = {
  x: (CLICK.clientX - PANNED.x) / PANNED.zoom - DEFAULT_SETTINGS.defaultNodeWidth / 2,
  y: (CLICK.clientY - PANNED.y) / PANNED.zoom - DEFAULT_SETTINGS.defaultNodeHeight / 2,
}

const agentNode: WsNode = {
  id: 'agent-1', kind: 'agent', x: 0, y: 0, width: 420, height: 320,
  cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'agent',
}

const pane = (): HTMLElement => {
  const el = document.querySelector('.react-flow__pane')
  if (!el) throw new Error('pane tidak ada')
  return el as HTMLElement
}

const menu = () => document.querySelector('[role="menu"]')

/** Satu klik SEPERTI BROWSER: `pointerdown` lebih dulu, baru `click`. `fireEvent.click` saja tidak
 *  pernah mengirim `pointerdown`, jadi pembubar menu tidak pernah jalan — test yang cuma meng-klik
 *  tetap hijau di atas menu yang mati total di browser. Itulah cara bug ini lolos sebelumnya. */
function pointerClick(el: HTMLElement): void {
  fireEvent.pointerDown(el)
  fireEvent.click(el)
}

/** Posisi node React Flow dibaca dari `transform` wrapper-nya — itulah yang BENAR-BENAR digambar,
 *  bukan apa yang ada di state. `translate(Xpx, Ypx)`. */
function nodePositions(kind: string): { x: number; y: number }[] {
  return Array.from(document.querySelectorAll(`.react-flow__node-${kind}`)).map((el) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform)
    if (!m) throw new Error(`node ${kind} tanpa transform: ${(el as HTMLElement).style.transform}`)
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  })
}

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

describe('menu konteks canvas', () => {
  it('klik kanan di pane memunculkan menunya DAN menahan menu bawaan browser', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    expect(menu()).toBeNull()

    // `cancelable: true` supaya `defaultPrevented` punya arti: inilah satu-satunya cara memastikan
    // menu konteks browser benar-benar ditahan, dan itu keluhan asli penggunanya.
    const ev = new MouseEvent('contextmenu', { ...CLICK, bubbles: true, cancelable: true })
    fireEvent(pane(), ev)

    await waitFor(() => expect(menu()).not.toBeNull())
    expect(ev.defaultPrevented).toBe(true)
    expect(menu()?.getAttribute('aria-label')).toBe('Canvas actions')
  })

  it('New terminal melahirkan node DI TITIK KLIK, bukan di posisi spawn default', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: PANNED })
    fireEvent.contextMenu(pane(), CLICK)
    await waitFor(() => expect(menu()).not.toBeNull())

    fireEvent.click(await screen.findByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR))

    await waitFor(() => expect(nodePositions('terminal')).toHaveLength(1))
    expect(nodePositions('terminal')[0]).toEqual(AT_CLICK)
    // Dua gerbang terhadap "lulus karena kebetulan": titik klik bukan posisi spawn default, dan
    // titik FLOW-nya bukan titik LAYAR-nya — jadi test ini ikut mati kalau konversinya dilewati.
    expect(AT_CLICK).not.toEqual(DEFAULT_SPAWN)
    expect(AT_CLICK).not.toEqual({
      x: CLICK.clientX - DEFAULT_SETTINGS.defaultNodeWidth / 2,
      y: CLICK.clientY - DEFAULT_SETTINGS.defaultNodeHeight / 2,
    })
  })

  it('menu menutup setelah sebuah item dipilih', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)
    await waitFor(() => expect(menu()).not.toBeNull())

    fireEvent.click(await screen.findByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR))
    await waitFor(() => expect(menu()).toBeNull())
  })

  it('Escape menutup menu tanpa melahirkan apa pun', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)
    const panel = await waitFor(() => {
      const m = menu()
      if (!m) throw new Error('menu belum muncul')
      return m
    })

    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() => expect(menu()).toBeNull())
    expect(nodePositions('terminal')).toHaveLength(0)
  })

  it('klik kanan DI ATAS node tidak memunculkan menu canvas', async () => {
    await mountCanvas({ nodes: [agentNode], dirs: {} })
    const node = document.querySelector('.react-flow__node-agent')
    expect(node).not.toBeNull()

    fireEvent.contextMenu(node as HTMLElement, CLICK)

    // Menu canvas TIDAK boleh ada. Menu node (`NodeContextMenu`) punya jalannya sendiri di dalam
    // AgentNode; yang diuji di sini adalah tidak adanya menu canvas yang dobel di atasnya.
    expect(document.querySelector('[aria-label="Canvas actions"]')).toBeNull()
  })

  it('Select all nonaktif di canvas kosong — diklik pun tidak memilih apa pun', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)
    const row = await screen.findByText(MENU_LABELS.selectAll)
    const button = row.closest('button')
    expect(button?.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(button as HTMLElement)
    // Baris mati tidak boleh menutup menu ataupun mengubah seleksi: tidak ada node yang terpilih,
    // dan panel tetap terbuka supaya pengguna bisa memilih yang lain.
    expect(document.querySelectorAll('.react-flow__node.selected')).toHaveLength(0)
    expect(menu()).not.toBeNull()
  })

  it('Select all di canvas berisi node benar-benar memilih node itu', async () => {
    await mountCanvas({ nodes: [agentNode], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)
    fireEvent.click(await screen.findByText(MENU_LABELS.selectAll))

    await waitFor(() => expect(document.querySelectorAll('.react-flow__node.selected')).toHaveLength(1))
  })

  // Pembubar menu dulu menutup panel pada pointerdown MANA PUN, termasuk yang mendarat di dalam
  // panel itu sendiri: barisnya lenyap sebelum `click` terbentuk, jadi aksinya tak pernah jalan.
  // Test-test di atas tidak melihatnya karena `fireEvent.click` tidak mengirim `pointerdown`.
  it('New terminal tetap melahirkan node saat diklik dengan pointerdown lebih dulu', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)

    pointerClick(await screen.findByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR))

    await waitFor(() => expect(nodePositions('terminal')).toHaveLength(1))
    await waitFor(() => expect(menu()).toBeNull())
  })

  it('pointerdown di dalam panel tidak menutup menunya', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)

    fireEvent.pointerDown(await screen.findByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR))

    expect(menu()).not.toBeNull()
  })

  // Flyout submenu adalah portal tersendiri; pembubar luar harus mengenalinya lewat registri menu.
  // Kalau tidak, klik baris submenu akan menutup menu tanpa aksi dan test ini yang merah.
  it('baris di dalam flyout submenu tetap bisa dipilih', async () => {
    await mountCanvas({ nodes: [], dirs: {}, ...WITH_CUSTOM })
    fireEvent.contextMenu(pane(), CLICK)
    fireEvent.pointerEnter(await screen.findByText(MENU_LABELS.agentGroup, OUTSIDE_SIDE_BAR))

    const subRow = await waitFor(() => {
      const el = document.querySelector('[aria-label="Canvas actions submenu"] button')
      if (!el) throw new Error('flyout submenu tidak terbuka')
      return el as HTMLElement
    })
    pointerClick(subRow)

    await waitFor(() => expect(nodePositions('agent')).toHaveLength(1))
    expect(menu()).toBeNull()
  })

  // Kasus yang melahirkan listener fase CAPTURE: `stopPropagation` di bawah meniru xterm, yang
  // menelan propagasi pointer-nya sendiri. Pembubar fase-bubble tidak akan pernah melihat klik ini.
  it('klik di luar menu tetap menutupnya walau propagasi pointer ditelan di bawahnya', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.contextMenu(pane(), CLICK)
    await waitFor(() => expect(menu()).not.toBeNull())
    pane().addEventListener('pointerdown', (e) => e.stopPropagation())

    fireEvent.pointerDown(pane())

    await waitFor(() => expect(menu()).toBeNull())
  })

  // `onAddFiles` punya parameter opsional `at`; File > New Files Node (pengganti toolbar canvas
  // yang dihapus) harus melahirkan node di posisi angka, bukan NaN dari event yang ikut terkirim.
  it('File > New Files Node melahirkan node files di posisi angka; canvas tanpa toolbar mengapung', async () => {
    await mountCanvas({ nodes: [], dirs: { '/': [] } })
    expect(document.querySelector('.controls-cluster')).toBeNull()
    expect(screen.queryByLabelText('Command palette')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' })) // hamburger at the top of the rail
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Files Node' }))

    await waitFor(() => expect(nodePositions('files')).toHaveLength(1))
    expect(nodePositions('files')[0]).toEqual(DEFAULT_SPAWN)
  })

  it('Diff (working changes) melahirkan node diff di titik klik yang membaca diff cwd workspace', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: PANNED })
    fireEvent.contextMenu(pane(), CLICK)
    await waitFor(() => expect(menu()).not.toBeNull())
    fireEvent.click(await screen.findByText(MENU_LABELS.diff))

    await waitFor(() => expect(nodePositions('diff')).toHaveLength(1))
    expect(nodePositions('diff')[0]).toEqual(AT_CLICK)
    // Workspace fixture cwd is '/': the node asks the diff API for exactly that root.
    const askedRoot = () => vi.mocked(fetch).mock.calls
      .map((c) => new URL(String(c[0]), 'http://localhost'))
      .some((u) => u.pathname === '/api/git/diff' && u.searchParams.get('root') === '/')
    await waitFor(() => expect(askedRoot()).toBe(true))
  })
})

describe('menu konteks canvas — fidelity VS Code', () => {
  it('memakai VscodeMenu: baris menuitem 22px-class, ikon codicon, caret submenu, tooltip alasan', async () => {
    await mountCanvas({ nodes: [], dirs: {}, ...WITH_CUSTOM })
    fireEvent.contextMenu(pane(), CLICK)
    await screen.findByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR)

    const rows = Array.from(document.querySelectorAll('[data-slot="vscode-menu-row"]'))
    expect(rows.map((r) => r.textContent)).toContain(MENU_LABELS.terminal)
    expect(document.querySelector('.vscode-menu__icon .codicon-terminal')).not.toBeNull()
    const group = screen.getByText(MENU_LABELS.agentGroup, OUTSIDE_SIDE_BAR).closest('button')
    expect(group?.getAttribute('aria-haspopup')).toBe('menu')
    expect(group?.querySelector('.codicon-chevron-right')).not.toBeNull()
    // Alasan baris mati sampai ke pengguna lewat tooltip, bukan hanya redup.
    expect(screen.getByText(MENU_LABELS.selectAll).closest('button')?.getAttribute('title')).toBeTruthy()
  })

  it('ArrowRight membuka submenu dan ArrowLeft menutupnya tanpa menutup menu induk', async () => {
    await mountCanvas({ nodes: [], dirs: {}, ...WITH_CUSTOM })
    fireEvent.contextMenu(pane(), CLICK)
    const group = (await screen.findByText(MENU_LABELS.agentGroup, OUTSIDE_SIDE_BAR)).closest('button') as HTMLElement
    fireEvent.pointerEnter(group)
    const sub = () => document.querySelector('[aria-label="Canvas actions submenu"]')
    await waitFor(() => expect(sub()).not.toBeNull())

    fireEvent.keyDown(sub()?.querySelector('button') as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(sub()).toBeNull())
    expect(menu()).not.toBeNull()
  })
})
