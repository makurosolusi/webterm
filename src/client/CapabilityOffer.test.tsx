/** @vitest-environment jsdom */
// CapabilityOffer: hanya tampil bila belum aktif; "Nyalakan" memanggil API lalu onDone.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityOffer } from './CapabilityOffer'
import { resetCapabilitiesCache } from './useCapabilities'

const body = (status: string, extra: object = {}) =>
  JSON.stringify({ capabilities: [{ id: 'browser', title: 'Browser di kanvas', blurb: 'Buka halaman web sebagai node di kanvas.', status, ...extra }], advanced: {} })

beforeEach(resetCapabilitiesCache)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('CapabilityOffer', () => {
  it('renders nothing when the capability is on', async () => {
    const f = vi.fn().mockResolvedValue(new Response(body('on')))
    vi.stubGlobal('fetch', f)
    const { container } = render(<CapabilityOffer id="browser" />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await Promise.resolve()
    expect(container.innerHTML).toBe('')
  })

  it('offers when off; Nyalakan posts {enabled:true} then calls onDone', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(body('off'))).mockResolvedValueOnce(new Response(body('on')))
    vi.stubGlobal('fetch', f)
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    expect(await screen.findByText(/Buka halaman web sebagai node di kanvas\. Nyalakan sekarang\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Nyalakan' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls[1][0]).toBe('/api/capabilities/browser')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ enabled: true })
  })

  it('shows the step for needs-step instead of the enable button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body('needs-step', { step: { kind: 'chromiumPath', label: 'Pilih lokasi' } }))))
    render(<CapabilityOffer id="browser" />)
    expect(await screen.findByRole('button', { name: 'Pilih lokasi' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Nyalakan' })).toBeNull()
    expect(screen.queryByText(/WEBTERM_|restart|berbahaya/i)).toBeNull()
  })

  it('keeps the offer and shows an alert when the toggle fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(body('off'))).mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403 })))
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nyalakan' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Perubahan ini hanya bisa dilakukan dari aplikasi ini.')
    expect(onDone).not.toHaveBeenCalled()
  })
})
