/**
 * @vitest-environment jsdom
 */
// Clean view (mode fokus), diuji di canvas SUNGGUHAN (`./canvasHarness`).
//
// Test yang PALING penting di file ini adalah jalan keluarnya: di clean view seluruh chrome
// disembunyikan, jadi chord ⌘./Ctrl+. adalah satu-satunya jalan pulang. Kalau listener-nya diam,
// fiturnya bukan fitur — ia perangkap. Karena itu ia diuji dari dua arah: chord yang BENAR
// mematikannya, dan chord platform yang SALAH tidak — yang kedua membuktikan predikatnya memang
// `isCleanViewChord`, bukan pencocokan '.' yang longgar.
//
// TIDAK TERUJI DI SINI: apa pun yang butuh layout. jsdom tidak menerapkan CSS, jadi "chrome-nya
// benar-benar tidak terlihat" dan "petunjuknya memudar" tidak bisa diamati — yang bisa dipaku
// adalah kelas body yang menggantung aturannya, plus penjaga teks atas sheet-nya sendiri.
import { readFileSync } from 'node:fs'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { CLEAN_VIEW_CLASS } from './cleanView'
import type { WsNode } from '../shared/workspace'

/** Sheet dibaca relatif ke root repo (cwd runner) — alasan sama dengan `dockSessions.test.tsx`:
 *  di transform web Vite, `new URL('./x', import.meta.url)` jadi URL aset dan yang terbaca adalah
 *  source test ini sendiri, sehingga guard-nya palsu. */
const read = (f: string) => readFileSync(`src/client/${f}`, 'utf8')

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

/** Bohongi platform yang dibaca `isMacPlatform()`. jsdom melaporkan platform kosong (bukan mac),
 *  jadi tanpa ini chord mac tidak akan pernah cocok dan "jalan keluar" hijau karena kebetulan. */
function stubPlatform(platform: string): void {
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform } })
}

const MAC_CHORD = { key: '.', code: 'Period', metaKey: true }
const CTRL_CHORD = { key: '.', code: 'Period', ctrlKey: true }

const toggle = () => screen.getByLabelText('Clean view')
const isOn = () => document.body.classList.contains(CLEAN_VIEW_CLASS)

beforeAll(installCanvasDom)
beforeEach(() => stubPlatform('macOS'))
afterEach(() => {
  unmountCanvas()
  Reflect.deleteProperty(navigator, 'userAgentData')
})

describe('masuk clean view', () => {
  it('klik tombol dock memasang kelas body, dan aria-pressed mengikuti', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    expect(isOn()).toBe(false)
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(toggle().closest('.dock')).not.toBeNull()

    fireEvent.click(toggle())

    await waitFor(() => expect(isOn()).toBe(true))
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('petunjuk jalan keluar muncul, menyebut chord-nya, dan hilang saat keluar', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    expect(document.querySelector('.clean-view-hint')).toBeNull()

    fireEvent.click(toggle())

    await waitFor(() => expect(document.querySelector('.clean-view-hint')).not.toBeNull())
    expect(document.querySelector('.clean-view-hint')?.textContent).toContain('⌘.')

    fireEvent.click(toggle())
    await waitFor(() => expect(document.querySelector('.clean-view-hint')).toBeNull())
  })
})

describe('jalan keluar lewat chord', () => {
  // Test yang paling mahal kalau diam-diam mati: tanpa ini, clean view adalah pintu satu arah.
  it('⌘. di window BENAR-BENAR mematikannya', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.click(toggle())
    await waitFor(() => expect(isOn()).toBe(true))

    fireEvent.keyDown(window, MAC_CHORD)

    await waitFor(() => expect(isOn()).toBe(false))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('chord yang sama juga MENYALAKANNYA (dua jalan masuk, dua jalan keluar)', async () => {
    await mountCanvas({ nodes: [], dirs: {} })

    fireEvent.keyDown(window, MAC_CHORD)

    await waitFor(() => expect(isOn()).toBe(true))
  })

  it('chord platform yang SALAH tidak menyentuhnya', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.click(toggle())
    await waitFor(() => expect(isOn()).toBe(true))

    // Diperiksa SATU-SATU, bukan setelah ketiganya: dua chord yang keliru lolos akan saling
    // membatalkan dan assertion terakhirnya hijau walau keduanya menembus.
    // Di mac, Ctrl+. adalah tombol yang dikirim orang ke shell — bukan chord app.
    fireEvent.keyDown(window, CTRL_CHORD)
    expect(isOn()).toBe(true)
    // '.' polos, tanpa modifier.
    fireEvent.keyDown(window, { key: '.', code: 'Period' })
    expect(isOn()).toBe(true)
    // ⌘⇧. — bentuk chord LAIN, bukan ini.
    fireEvent.keyDown(window, { key: '>', code: 'Period', metaKey: true, shiftKey: true })
    expect(isOn()).toBe(true)
  })

  it('di luar mac, Ctrl+. yang jadi chord-nya dan ⌘. yang diam', async () => {
    stubPlatform('Windows')
    await mountCanvas({ nodes: [], dirs: {} })

    fireEvent.keyDown(window, MAC_CHORD)
    expect(isOn()).toBe(false)

    fireEvent.keyDown(window, CTRL_CHORD)
    await waitFor(() => expect(isOn()).toBe(true))
  })

  it('listener window-nya dilepas saat unmount — tidak ada yatim', async () => {
    const added = new Set<EventListenerOrEventListenerObject>()
    const removed = new Set<EventListenerOrEventListenerObject>()
    const origAdd = window.addEventListener.bind(window)
    const origRemove = window.removeEventListener.bind(window)
    // Dibungkus langsung, bukan lewat `vi.spyOn`: `unmountCanvas` memanggil `unstubAllGlobals`,
    // dan pelepasan yang terjadi DI DALAM unmount itu harus masih tercatat.
    window.addEventListener = ((t: string, h: EventListenerOrEventListenerObject, o?: unknown) => {
      if (t === 'keydown' && h) added.add(h)
      return origAdd(t, h, o as never)
    }) as typeof window.addEventListener
    window.removeEventListener = ((t: string, h: EventListenerOrEventListenerObject, o?: unknown) => {
      if (t === 'keydown' && h) removed.add(h)
      return origRemove(t, h, o as never)
    }) as typeof window.removeEventListener

    try {
      await mountCanvas({ nodes: [], dirs: {} })
      expect(added.size).toBeGreaterThan(0)
      unmountCanvas()

      // Setiap listener keydown yang dipasang app harus punya pelepasannya.
      expect([...added].filter((h) => !removed.has(h))).toHaveLength(0)
    } finally {
      window.addEventListener = origAdd
      window.removeEventListener = origRemove
    }
  })
})

describe('tidak dipersist, dan tidak meng-unmount apa pun', () => {
  it('tidak menulis apa pun ke localStorage, dan mount ulang mulai normal', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    const before = JSON.stringify({ ...localStorage })

    fireEvent.click(toggle())
    await waitFor(() => expect(isOn()).toBe(true))

    expect(JSON.stringify({ ...localStorage })).toBe(before)
    expect(Object.keys({ ...localStorage }).some((k) => /clean/i.test(k))).toBe(false)

    unmountCanvas()
    expect(isOn()).toBe(false)
    await mountCanvas({ nodes: [], dirs: {} })
    expect(isOn()).toBe(false)
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('node tetap terender saat clean view menyala — penyembunyiannya CSS, bukan unmount', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    expect(document.querySelector('.react-flow__node-terminal')).not.toBeNull()

    fireEvent.click(toggle())
    await waitFor(() => expect(isOn()).toBe(true))

    // Node, header node, DAN chrome yang disembunyikan semuanya masih di DOM: yang dibuang cuma
    // pikselnya. Dock yang hilang dari DOM berarti state-nya (menu terbuka, filter) ikut hilang.
    expect(document.querySelector('.react-flow__node-terminal')).not.toBeNull()
    expect(document.querySelector('.react-flow__node-terminal .node-header')).not.toBeNull()
    expect(document.querySelector('.dock')).not.toBeNull()
    expect(document.querySelector('.tabbar')).not.toBeNull()
  })
})

describe('cleanView.css — penjaga teks', () => {
  const css = read('cleanView.css')
  /** Aturan penyembunyi SAJA, tanpa komentar di atasnya: komentarnya menyebut `display: none` dan
   *  beberapa nama kelas, jadi slice yang lebih longgar akan lulus atas prosa. */
  const hide = css.slice(css.indexOf('body.clean-view .'), css.indexOf('.clean-view-hint {'))

  it('menyasar tepat selector chrome yang dimaksud, lewat kelas body', () => {
    expect(hide).toContain('display: none')
    for (const sel of [
      '.tabbar',            // header workspace
      '.dock',              // kolom kontrol kiri
      '.dock-backdrop',     // lapisan tangkap-klik tak terlihat di bawah menu dock
      '.sessions-sidebar',  // panel Sessions
      '.minimap-dock',      // minimap
      '.controls-cluster',  // toolbar kanan-atas
    ]) {
      expect(hide).toContain(`body.${CLEAN_VIEW_CLASS} ${sel}`)
    }
  })

  it('TIDAK menyembunyikan canvas maupun chrome per-node', () => {
    for (const kept of ['.react-flow', '.node-header', '.node-toolbar', '.term-node']) {
      expect(hide).not.toContain(kept)
    }
  })

  it('petunjuknya pointer-events: none dan memudar sendiri', () => {
    const hint = css.slice(css.indexOf('.clean-view-hint {'))
    // WAJIB: ia melayang di atas canvas tempat shell menggambar prompt-nya.
    expect(hint).toContain('pointer-events: none')
    // `forwards`, kalau tidak ia melompat balik ke opacity penuh dan menetap di layar.
    expect(hint).toContain('animation: clean-view-hint-fade')
    expect(hint).toContain('forwards')
    expect(hint).toContain('@keyframes clean-view-hint-fade')
    // Opacity SAJA — bukan transform/posisi; itu yang membuat override reduced-motion tak perlu.
    const frames = hint.slice(hint.indexOf('@keyframes'))
    expect(frames).toContain('opacity: 1')
    expect(frames).toContain('opacity: 0')
    expect(frames).not.toContain('transform')
  })

  it('tidak ada hover-reveal / proximity-reveal yang dihidupkan lagi', () => {
    expect(css).not.toContain(':hover')
  })
})
