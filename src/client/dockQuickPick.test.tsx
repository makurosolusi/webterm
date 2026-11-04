/**
 * @vitest-environment jsdom
 */
// Tombol "+" (Add node) harus benar-benar toggle: mousedown+click pada tombol yang sama menutup
// Quick Pick, bukan menutup lalu membukanya lagi.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dock, { type DockProps } from './Dock'
import { resetCapabilitiesCache } from './useCapabilities'

const noop = () => {}
const baseProps: DockProps = {
  onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
  onUndo: noop, onRedo: noop, canUndo: false, canRedo: false,
  onBack: noop, onForward: noop, canBack: false, canForward: false,
  onFit: noop, onToggleBoard: noop, sessionsOpen: false, onToggleSessions: noop,
  inboxOpen: false, onToggleInbox: noop, zoomPct: 100, onZoomIn: noop, onZoomOut: noop,
  locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop,
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetCapabilitiesCache() })

const press = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el) }

describe('Quick Pick "Add node" di Dock', () => {
  it('tombol + membuka, lalu menekannya lagi menutup', () => {
    render(<Dock {...baseProps} />)
    const plus = screen.getByRole('button', { name: 'Add node' })
    press(plus)
    expect(screen.getByRole('dialog', { name: 'Add node' })).toBeTruthy()
    press(plus)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape dan mousedown di luar menutup', () => {
    render(<Dock {...baseProps} />)
    press(screen.getByRole('button', { name: 'Add node' }))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    press(screen.getByRole('button', { name: 'Add node' }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('baris Browser saat kemampuan browser mati', () => {
  // test-only: server kemampuan dengan browser off; POST menyalakannya.
  const caps = (status: string) => new Response(JSON.stringify({
    capabilities: [{ id: 'browser', title: 'Browser di kanvas', blurb: 'Buka halaman web sebagai node di kanvas.', status }], advanced: {},
  }))

  it('tetap tampil; memilihnya memunculkan tawaran Nyalakan, lalu node lahir setelah menyala', async () => {
    const f = vi.fn().mockResolvedValueOnce(caps('off')).mockResolvedValue(caps('on'))
    vi.stubGlobal('fetch', f)
    const { rerender } = render(<Dock {...baseProps} />)
    press(screen.getByRole('button', { name: 'Add node' }))
    fireEvent.click(screen.getByRole('option', { name: /Browser/ }))
    expect(await screen.findByText(/Nyalakan sekarang\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Nyalakan' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nyalakan Browser di kanvas' })).toBeNull())
    expect(f.mock.calls.some(([url, init]) => url === '/api/capabilities/browser' && JSON.parse(init.body).enabled === true)).toBe(true)
    const onAddBrowser = vi.fn()
    rerender(<Dock {...baseProps} onAddBrowser={onAddBrowser} />) // status browser termuat ulang -> App menerbitkan penambah
    expect(onAddBrowser).toHaveBeenCalledTimes(1)
  })

  it('menyala: memilih baris langsung menambah node tanpa tawaran', () => {
    const onAddBrowser = vi.fn()
    render(<Dock {...baseProps} onAddBrowser={onAddBrowser} />)
    press(screen.getByRole('button', { name: 'Add node' }))
    fireEvent.click(screen.getByRole('option', { name: /Browser/ }))
    expect(onAddBrowser).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Nyalakan Browser di kanvas' })).toBeNull()
  })
})
