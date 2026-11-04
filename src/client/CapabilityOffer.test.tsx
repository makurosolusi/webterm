/** @vitest-environment jsdom */
// CapabilityOffer: hanya tampil bila belum aktif; "Nyalakan" memanggil API lalu onDone.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityOffer } from './CapabilityOffer'
import { CAPABILITY_TEXT, forbiddenText } from './capabilitiesLabels'
import { resetCapabilitiesCache } from './useCapabilities'

const chromiumPath = { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: ['/opt/chrome'] } // test-only
const agentEngine = { value: 'auto', detected: 'claude' } // test-only
const body = (status: string, extra: object = {}) =>
  JSON.stringify({ capabilities: [{ id: 'browser', title: 'Browser di kanvas', blurb: 'Buka halaman web sebagai node di kanvas.', status, ...extra }], advanced: { chromiumPath, agentEngine } })
const central = (status: string) => JSON.stringify({
  capabilities: [{ id: 'central', title: 'Agent Pusat', blurb: 'Asisten.', status, ...(status === 'needs-step' ? { step: { kind: 'agentEngine', label: 'Pasang atau login Claude Code / OpenCode' } } : {}) }],
  advanced: { chromiumPath, agentEngine },
})
const pathStep = { step: { kind: 'chromiumPath', label: 'Pilih lokasi' } }

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
    expect((await screen.findByRole('alert')).textContent).toBe(CAPABILITY_TEXT.forbidden)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('pesan 403 menyebut sebab dan jalan keluar (127.0.0.1:<port> atau token akses), port dari halaman', () => {
    expect(forbiddenText('8700')).toContain('http://127.0.0.1:8700')
    expect(forbiddenText('8700')).toMatch(/token akses/)
    expect(forbiddenText('')).not.toMatch(/127\.0\.0\.1:/)
    expect(forbiddenText('')).toMatch(/127\.0\.0\.1/)
    expect(forbiddenText('8700')).not.toMatch(/WEBTERM_|env/i)
  })

  it('Nyalakan yang berujung needs-step tidak memanggil onDone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(body('off'))).mockResolvedValue(new Response(body('needs-step', pathStep))))
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nyalakan' }))
    expect(await screen.findByRole('button', { name: 'Pilih lokasi' })).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('langkah Pilih lokasi tanpa onStep membuka kolom lokasi Chrome di tempat; simpan -> PUT /advanced -> onDone', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(body('needs-step', pathStep)))
      .mockResolvedValueOnce(new Response(body('on'))) // PUT /advanced
      .mockResolvedValue(new Response(body('on'))) // refresh
    vi.stubGlobal('fetch', f)
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pilih lokasi' }))
    fireEvent.click(screen.getByRole('button', { name: /\/opt\/chrome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan lokasi' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls[1][0]).toBe('/api/capabilities/advanced')
    expect(f.mock.calls[1][1].method).toBe('PUT')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ chromiumPath: '/opt/chrome' })
  })

  it('langkah fixChain menyalakan lewat toggle biasa, bukan /reset', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(body('needs-step', { step: { kind: 'fixChain', label: 'Nyalakan yang dibutuhkan' } }))).mockResolvedValue(new Response(body('on')))
    vi.stubGlobal('fetch', f)
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nyalakan yang dibutuhkan' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls.map((c) => c[0])).not.toContain('/api/capabilities/reset')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ enabled: true })
  })

  it('langkah agentEngine tanpa onStep: pilihan mesin + status jujur di tempat; Periksa lagi memuat ulang; onDone hanya saat on', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(central('needs-step')))
      .mockResolvedValueOnce(new Response(central('needs-step'))) // Periksa lagi #1: masih belum login
      .mockResolvedValue(new Response(central('on'))) // Periksa lagi #2: sudah login
    vi.stubGlobal('fetch', f)
    const onDone = vi.fn()
    render(<CapabilityOffer id="central" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pasang atau login Claude Code / OpenCode' }))
    expect(screen.getByLabelText('Mesin agen Agent Pusat')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Claude terpasang, tapi belum login. Login di terminal, lalu periksa lagi.')
    fireEvent.click(screen.getByRole('button', { name: 'Periksa lagi' }))
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Periksa lagi' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls.map((c) => [c[0], c[1]?.method ?? 'GET'])).toEqual([
      ['/api/capabilities', 'GET'], ['/api/capabilities?refresh=1', 'GET'], ['/api/capabilities?refresh=1', 'GET'],
    ])
  })
})
