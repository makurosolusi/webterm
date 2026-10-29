/**
 * @vitest-environment jsdom
 */
// Menu konteks node terminal, diuji di canvas SUNGGUHAN (pola yang sama dengan
// `canvasContextMenu.test.tsx`, dan alasannya sama: menu yang benar di level unit tapi tidak
// tersambung ke apa pun tidak membuat satu test unit pun merah).
//
// Keluhan aslinya: klik kanan di atas terminal memunculkan menu bawaan Chrome untuk `<canvas>`
// ("Copy Image"), karena `TerminalNode` tidak punya `onContextMenu` dan React Flow hanya
// meneruskan contextmenu yang target-nya pane itu sendiri. Jadi assertion yang menentukan di sini
// adalah `defaultPrevented` — tanpa itu test tetap hijau walau `preventDefault()` dihapus.
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import type { WsNode } from '../shared/workspace'

const CLICK = { clientX: 300, clientY: 220 }

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

/** Menu NODE, bukan menu canvas: keduanya `role="menu"` dan ber-class `node-menu`. */
const nodeMenu = (): HTMLElement | null =>
  document.querySelector('[role="menu"].node-menu:not(.node-menu--canvas)')

const row = (label: string): HTMLButtonElement => {
  const el = Array.from(nodeMenu()?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent === label,
  )
  if (!el) throw new Error(`baris "${label}" tidak ada di menu`)
  return el as HTMLButtonElement
}

/** Permukaan yang BENAR-BENAR diklik kanan pengguna: badan terminal, bukan wrapper React Flow.
 *  Bedanya bukan kosmetik — handler-nya duduk di `.term-node` di dalam wrapper, jadi event yang
 *  dilepas di wrapper tidak akan pernah turun ke sana. */
function termBody(): HTMLElement {
  const el = document.querySelector('.react-flow__node-terminal .node-body')
  if (!el) throw new Error('badan node terminal tidak dirender')
  return el as HTMLElement
}

/** Pasang/cabut `navigator.clipboard`: jsdom tidak mendefinisikannya sama sekali, jadi
 *  `vi.spyOn` tidak punya properti untuk dibungkus. Tanpa `clipboard` = keadaan non-secure-context. */
function stubClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

/** Klik kanan yang `cancelable`, supaya `defaultPrevented` punya arti. */
async function openMenu(): Promise<MouseEvent> {
  const ev = new MouseEvent('contextmenu', { ...CLICK, bubbles: true, cancelable: true })
  fireEvent(termBody(), ev)
  await waitFor(() => expect(nodeMenu()).not.toBeNull())
  return ev
}

beforeAll(installCanvasDom)
afterEach(() => {
  unmountCanvas()
  vi.restoreAllMocks()
  // @ts-expect-error -- dibersihkan supaya file test berikutnya tidak mewarisi clipboard palsu
  delete navigator.clipboard
})

describe('menu konteks node terminal', () => {
  it('klik kanan memunculkan menunya DAN menahan menu bawaan browser', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    expect(nodeMenu()).toBeNull()

    const ev = await openMenu()

    expect(ev.defaultPrevented).toBe(true)
    // Propagasi dihentikan juga, jadi menu canvas tidak ikut terbuka di bawahnya.
    expect(document.querySelector('.node-menu--canvas')).toBeNull()
  })

  it('Paste mati dengan alasan saat clipboard API tidak ada', async () => {
    // Persis keadaan webterm yang dibuka lewat alamat LAN `http://`: bukan secure context, jadi
    // `navigator.clipboard` absen sama sekali — dan itu juga default jsdom, jadi tanpa stub.
    expect(navigator.clipboard).toBeUndefined()
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await openMenu()

    const paste = row('Paste')
    expect(paste.disabled).toBe(true)
    // Baris mati tanpa alasan tak bisa dibedakan dari baris rusak.
    expect(paste.title).not.toBe('')
  })

  it('Paste membaca clipboard saat API-nya ada', async () => {
    const readText = vi.fn().mockResolvedValue('echo hi')
    stubClipboard({ readText })
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await openMenu()

    const paste = row('Paste')
    expect(paste.disabled).toBe(false)
    fireEvent.click(paste)

    expect(readText).toHaveBeenCalledTimes(1)
  })

  it('Clear membersihkan scrollback terminalnya lewat handle', async () => {
    // Prototype publik xterm, bukan tiruan: ini membuktikan `clear()` di `TerminalHandle`
    // benar-benar sampai ke terminal yang hidup, bukan cuma ada di interface-nya.
    const clear = vi.spyOn(Terminal.prototype, 'clear').mockImplementation(() => {})
    await mountCanvas({ nodes: [termNode], dirs: {} })
    await openMenu()

    fireEvent.click(row('Clear'))

    expect(clear).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(nodeMenu()).toBeNull())
  })
})
