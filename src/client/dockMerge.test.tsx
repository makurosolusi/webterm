/**
 * @vitest-environment jsdom
 */
// Peleburan rail zoom ke dalam dock, diuji di canvas SUNGGUHAN. Yang dijaga di sini bukan tata letak
// (jsdom tidak punya layout — tidak ada test yang bisa melihat kolomnya rapi), melainkan tiga hal
// yang bisa diamati dan justru yang paling mudah diam-diam rusak:
//
//   1. Lock benar-benar mengunci pandangan, bukan cuma merender tombol.
//   2. Kontrol zoom cuma ADA SATU set di seluruh canvas — rail lama memberi zoom in/out/fit kedua,
//      dan test inilah yang memerahkan kalau duplikatnya kembali.
//   3. Menu dock masih terbuka dan isinya terjangkau sesudah arah bukanya berubah.
//
// Lihat `./canvasHarness.tsx` untuk setup DOM-nya.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { ZOOM_PRESETS } from './Dock'

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

const pane = (): HTMLElement => {
  const el = document.querySelector('.react-flow__pane')
  if (!el) throw new Error('pane tidak ada')
  return el as HTMLElement
}

/** Pan BENAR-BENAR hidup, dibaca dari pane React Flow: ia memasang kelas `draggable` tepat saat
 *  `panOnDrag === true`. State App bisa benar sementara propsnya tak tersambung ke canvas; bedanya
 *  cuma terlihat di sini. */
const panEnabled = (): boolean => pane().classList.contains('draggable')

describe('lock view di dock', () => {
  it('mengunci pan canvas, bukan cuma menukar ikonnya', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    expect(panEnabled()).toBe(true)

    fireEvent.click(screen.getByLabelText('Lock view'))

    await waitFor(() => expect(panEnabled()).toBe(false))
    const btn = screen.getByLabelText('Unlock view')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.closest('.dock')).not.toBeNull()
  })

  it('klik kedua membuka kuncinya lagi', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.click(screen.getByLabelText('Lock view'))
    await waitFor(() => expect(panEnabled()).toBe(false))

    fireEvent.click(screen.getByLabelText('Unlock view'))
    await waitFor(() => expect(panEnabled()).toBe(true))
  })
})

describe('kontrol canvas cuma satu kumpulan', () => {
  it('tidak ada tombol zoom/fit kedua di mana pun', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    for (const label of ['Zoom in', 'Zoom out', 'Fit view', 'Lock view']) {
      expect(screen.getAllByLabelText(label)).toHaveLength(1)
    }
    // Rail lama membungkus <Controls> React Flow; platnya akan muncul kembali dengan selector ini.
    expect(document.querySelector('.react-flow__controls')).toBeNull()
  })

  it('dock hidup di LUAR subtree React Flow, jadi ia tidak perlu nopan/nowheel', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    const dock = document.querySelector('.dock')
    expect(dock).not.toBeNull()
    // Rail lama memakai `nopan nowheel` karena dirender DI DALAM <ReactFlow>: drag/scroll di atasnya
    // sampai ke d3-zoom pane. Dock tidak punya masalah itu selama ia tetap di luar — dan "tetap di
    // luar" itulah yang dijaga di sini, bukan ada/tidaknya kelas penangkalnya.
    expect(dock?.closest('.react-flow')).toBeNull()
  })
})

describe('menu dock sesudah pindah ke kolom kiri', () => {
  it('menu Add terbuka dan itemnya benar-benar melahirkan node', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.click(screen.getByLabelText('Add node'))

    const item = await screen.findByText('Terminal')
    expect(item.closest('.dock-add-menu')).not.toBeNull()

    fireEvent.click(item)
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-terminal')).toHaveLength(1))
  })

  it('menu Add menjangkau form workspace', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.click(screen.getByLabelText('Add node'))
    fireEvent.click(await screen.findByText('Workspace…'))

    const form = await waitFor(() => {
      const el = document.querySelector('.dock-menu__form')
      if (!el) throw new Error('form workspace belum muncul')
      return el
    })
    expect(form.querySelector('input[placeholder="name"]')).not.toBeNull()
  })

  it('readout zoom membuka daftar preset, dan memilih satu menutupnya', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.click(screen.getByText('100%'))

    const menu = await waitFor(() => {
      const el = document.querySelector('.dock-zoom-menu')
      if (!el) throw new Error('menu preset belum muncul')
      return el
    })
    // Semua preset terjangkau, bukan cuma panelnya muncul.
    for (const p of ZOOM_PRESETS) expect(menu.textContent).toContain(`${p}%`)

    fireEvent.click(await screen.findByText('150%'))
    await waitFor(() => expect(document.querySelector('.dock-zoom-menu')).toBeNull())
  })
})
