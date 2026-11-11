/** @vitest-environment jsdom */
// CapabilityOffer: hanya tampil bila belum aktif; "Turn on" memanggil API lalu onDone.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityOffer } from './CapabilityOffer'
import { CAPABILITY_TEXT } from './capabilitiesLabels'
import { resetCapabilitiesCache } from './useCapabilities'

const chromiumPath = { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: ['/opt/chrome'] } // test-only
const agentEngine = { value: 'auto', detected: 'claude' } // test-only
const body = (status: string, extra: object = {}) =>
  JSON.stringify({ capabilities: [{ id: 'browser', title: 'Browser on canvas', blurb: 'Open web pages as nodes on the canvas.', status, ...extra }], advanced: { chromiumPath, agentEngine } })
const central = (status: string) => JSON.stringify({
  capabilities: [{ id: 'central', title: 'Central Agent', blurb: 'Asisten.', status, ...(status === 'needs-step' ? { step: { kind: 'agentEngine', label: 'Set up Claude Code' } } : {}) }],
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
    expect(await screen.findByText(/Open web pages as nodes on the canvas\. Turn it on now\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls[1][0]).toBe('/api/capabilities/browser')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ enabled: true })
  })

  it('shows the step for needs-step instead of the enable button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body('needs-step', { step: { kind: 'chromiumPath', label: 'Pilih lokasi' } }))))
    render(<CapabilityOffer id="browser" />)
    expect(await screen.findByRole('button', { name: 'Pilih lokasi' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
    expect(screen.queryByText(/WEBTERM_|restart|berbahaya/i)).toBeNull()
  })

  it('keeps the offer and shows an alert when the toggle fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(body('off'))).mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403 })))
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    expect((await screen.findByRole('alert')).textContent).toBe(CAPABILITY_TEXT.forbidden)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('pesan 403 menyebut sebab (sesi berakhir) dan jalan keluar (reload lalu sign in), tanpa alamat atau token', () => {
    expect(CAPABILITY_TEXT.forbidden).toBe('Your session has ended. Reload to sign in again.')
    expect(CAPABILITY_TEXT.forbidden).not.toMatch(/127\.0\.0\.1|access token|WEBTERM_|env/i)
  })

  it('Nyalakan yang berujung needs-step tidak memanggil onDone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(body('off'))).mockResolvedValue(new Response(body('needs-step', pathStep))))
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Show suggestions' }))
    fireEvent.click(screen.getByRole('option', { name: '/opt/chrome' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls[1][0]).toBe('/api/capabilities/advanced')
    expect(f.mock.calls[1][1].method).toBe('PUT')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ chromiumPath: '/opt/chrome' })
  })

  it('langkah fixChain menyalakan lewat toggle biasa, bukan /reset', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(body('needs-step', { step: { kind: 'fixChain', label: 'Turn on what’s needed' } }))).mockResolvedValue(new Response(body('on')))
    vi.stubGlobal('fetch', f)
    const onDone = vi.fn()
    render(<CapabilityOffer id="browser" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on what’s needed' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(f.mock.calls.map((c) => c[0])).not.toContain('/api/capabilities/reset')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ enabled: true })
  })

  it('langkah agentEngine tanpa onStep: engine status from the launch test (no picker) + fix hint; Check again memuat ulang; onDone hanya saat on', async () => {
    const caps = vi.fn()
      .mockResolvedValueOnce(new Response(central('needs-step')))
      .mockResolvedValueOnce(new Response(central('needs-step'))) // Check again #1: masih belum siap
      .mockResolvedValue(new Response(central('on'))) // Check again #2: siap
    const launch = vi.fn(async () => new Response(JSON.stringify({
      ok: false, profile: { id: 'default', name: 'Default' }, failed: 'auth_failed', warnings: [],
      steps: [{ stage: 'claude', ok: true, message: 'claude found' }, { stage: 'auth', ok: false, message: 'Claude Code is not signed in.', hint: 'Run "claude auth login" on the server.' }],
    })))
    const f = vi.fn((url: string, init?: RequestInit) => (url === '/api/claude-launch/test' ? launch() : caps(url, init)))
    vi.stubGlobal('fetch', f)
    const onDone = vi.fn()
    render(<CapabilityOffer id="central" onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up Claude Code' }))
    expect(screen.getByText('Engine')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(await screen.findByText('Launch profile: Default')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('Claude cannot start: Claude Code is not signed in.')
    expect(screen.getByText('Run "claude auth login" on the server.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(caps).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(2)) // the stage check re-runs too
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(caps.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method ?? 'GET'])).toEqual([
      ['/api/capabilities', 'GET'], ['/api/capabilities?refresh=1', 'GET'], ['/api/capabilities?refresh=1', 'GET'],
    ])
  })
})
