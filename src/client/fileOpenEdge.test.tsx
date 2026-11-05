/**
 * @vitest-environment jsdom
 */
// Test DOM pertama di repo ini. Yang diuji BUKAN sebuah helper murni: ia alur pengguna lengkap —
// node file manager di canvas sungguhan, klik ganda sebuah file, node editor lahir, dan kabel
// penanda "file ini sedang terbuka" terpasang di antara keduanya.
//
// Sebabnya ada: keputusannya (`./fileOpen`) sudah punya test node-env sendiri dan HIJAU, tapi kabel
// itu tetap tidak muncul di layar. Jarak antara "planner memutuskan dengan benar" dan "React Flow
// menggambarnya" cuma bisa dijembatani DOM — lihat `./canvasHarness.tsx`.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, renderedEdgeIds, unmountCanvas } from './canvasHarness'
import { EDGE_WIDTH, SELECTED_ARROW_STROKE } from './canvasStyle'
import type { WsNode } from '../shared/workspace'

// Monaco adalah beberapa MB JS di balik dynamic import ber-suffix `?worker` milik Vite, dan node
// editor memuatnya saat mount. Distub DI BATAS pemuatannya — bukan di EditorNode — supaya yang
// diuji tetap node editor sungguhan: ia tetap mount, tetap jadi ujung kabel, hanya tanpa Monaco.
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => new Promise(() => {}) }))

const FILES_ID = 'files-node'
const DIR = '/projects/wibu'

const filesNode: WsNode = {
  id: FILES_ID, kind: 'files', x: 0, y: 0, width: 420, height: 320, dirPath: DIR, title: 'wibu',
}

const LISTING = [
  { name: 'data', dir: true },
  { name: 'package.json', dir: false },
  { name: 'test.txt', dir: false },
]

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

/** Node editor yang lahir dari node files memakai `crypto.randomUUID()`, jadi id-nya tidak bisa
 *  ditebak di sini — kabelnya dikenali dari ujung yang DIKETAHUI: `bridge-<files id>-…`. */
const fileOpenEdges = () => renderedEdgeIds().filter((id) => id.startsWith(`bridge-${FILES_ID}-`))

describe('buka file dari node files', () => {
  it('melahirkan node editor DAN kabel penandanya', async () => {
    await mountCanvas({ nodes: [filesNode], dirs: { [DIR]: LISTING }, files: { [`${DIR}/test.txt`]: 'ini test menulis' } })

    // Listing mendarat lewat `fsClient.list` → fetch yang distub harness.
    fireEvent.doubleClick(await screen.findByText('test.txt'))

    // Node editor-nya: judulnya nama file, dan ia node React Flow bertipe editor.
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-editor')).toHaveLength(1))

    // INTI test. Kabel penanda harus ada di canvas, bukan hanya di state.
    await waitFor(() => expect(fileOpenEdges()).toHaveLength(1))
  })

  it('kabelnya berlabel "open", bukan "context" — agent tidak membaca file ini', async () => {
    await mountCanvas({ nodes: [filesNode], dirs: { [DIR]: LISTING } })
    fireEvent.doubleClick(await screen.findByText('package.json'))
    await waitFor(() => expect(fileOpenEdges()).toHaveLength(1))
    // Label hidup di `<text>` SVG milik edge; `decorateEdges` memilihnya dari `data.kind`.
    expect(document.querySelector('.react-flow__edge-textwrapper')?.textContent).toContain('open')
  })

  it('folder dibuka dengan navigasi, TANPA node editor dan tanpa kabel', async () => {
    await mountCanvas({ nodes: [filesNode], dirs: { [DIR]: LISTING, [`${DIR}/data`]: [{ name: 'inner.txt', dir: false }] } })
    fireEvent.doubleClick(await screen.findByText('data'))
    await screen.findByText('inner.txt')
    expect(document.querySelectorAll('.react-flow__node-editor')).toHaveLength(0)
    expect(fileOpenEdges()).toHaveLength(0)
  })

  it('kabel punya halo di BELAKANG garis utama, tak menangkap pointer; panah idle bukan penanda terpilih', async () => {
    await mountCanvas({ nodes: [filesNode], dirs: { [DIR]: LISTING } })
    fireEvent.doubleClick(await screen.findByText('package.json'))
    await waitFor(() => expect(fileOpenEdges()).toHaveLength(1))
    const edgeEl = document.querySelector('.react-flow__edge') as Element
    const halos = edgeEl.querySelectorAll('.edge-halo')
    expect(halos).toHaveLength(1)
    const halo = halos[0] as SVGPathElement
    const main = edgeEl.querySelector('.react-flow__edge-path') as SVGPathElement
    expect(main.style.strokeWidth).toBe(`var(--edge-hover-width, ${EDGE_WIDTH}px)`)
    expect(halo.style.pointerEvents).toBe('none')
    expect(halo.getAttribute('d')).toBe(main.getAttribute('d'))
    expect(Number(halo.getAttribute('stroke-width'))).toBeGreaterThan(EDGE_WIDTH)
    // Urutan dokumen = urutan gambar: halo harus mendahului garis utama.
    expect(halo.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Panah idle tidak boleh cocok dengan selector CSS panah terpilih.
    const ids = Array.from(document.querySelectorAll('.react-flow__arrowhead')).map((el) => el.closest('marker')?.id ?? '')
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).not.toContain(`strokeWidth=${SELECTED_ARROW_STROKE}`)
  })
})
