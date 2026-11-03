/** @vitest-environment jsdom */
// Kartu kemampuan: satu switch, status, langkah, "Ikut menyalakan/mati", sub-opsi hanya saat aktif.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityView } from '../shared/featureCapabilities'
import { CapabilityCard } from './CapabilityCard'

afterEach(cleanup)

const view = (o: Partial<CapabilityView>): CapabilityView =>
  ({ id: 'workers', title: 'Worker orchestrator', blurb: 'Izinkan agent menjalankan perintah.', status: 'off', ...o })

describe('CapabilityCard', () => {
  it('renders exactly one switch with the status text', () => {
    render(<CapabilityCard view={view({ status: 'on' })} onToggle={() => undefined} />)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('Aktif')
  })

  it('shows Mati for off', () => {
    render(<CapabilityCard view={view({})} onToggle={() => undefined} />)
    expect(screen.getByRole('status').textContent).toContain('Mati')
  })

  it('needs-step shows the step button and a disabled switch', () => {
    const onStep = vi.fn()
    render(<CapabilityCard view={view({ id: 'browser', status: 'needs-step', step: { kind: 'chromiumPath', label: 'Pilih lokasi' } })} onToggle={() => undefined} onStep={onStep} />)
    expect(screen.getByRole('status').textContent).toContain('Perlu satu langkah')
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Pilih lokasi' }))
    expect(onStep).toHaveBeenCalledWith('chromiumPath')
  })

  it('lists what turns on before the click (server field)', () => {
    render(<CapabilityCard view={view({ id: 'autonomy', title: 'Otonomi Agent Pusat', alsoTurnsOn: ['central', 'workers'] })} onToggle={() => undefined} />)
    expect(screen.getByText(/Ikut menyalakan: Agent Pusat, Worker orchestrator/)).toBeTruthy()
  })

  it('lists what turns off while on (dependents that are on)', () => {
    const all = [view({ id: 'central', title: 'Agent Pusat', status: 'on' }), view({ status: 'on' }), view({ id: 'autonomy', status: 'off' })]
    render(<CapabilityCard view={all[0]} all={all} onToggle={() => undefined} />)
    expect(screen.getByText(/Ikut mati: Worker orchestrator$/)).toBeTruthy()
  })

  it('hides sub-options when off and shows them (not as switches) when on', () => {
    const subs = [{ key: 'K', label: 'Minta persetujuan sebelum worker berjalan', on: true }]
    const { rerender } = render(<CapabilityCard view={view({ subs })} onToggle={() => undefined} />)
    expect(screen.queryByText(/Minta persetujuan/)).toBeNull()
    const onSub = vi.fn()
    rerender(<CapabilityCard view={view({ status: 'on', subs })} onToggle={() => undefined} onSub={onSub} />)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    fireEvent.click(screen.getByRole('checkbox', { name: /Minta persetujuan/ }))
    expect(onSub).toHaveBeenCalledWith('K', false)
  })

  it('toggle reports the requested state', () => {
    const onToggle = vi.fn()
    render(<CapabilityCard view={view({})} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('busy sets aria-busy and disables the switch; error is an alert', () => {
    render(<CapabilityCard view={view({})} busy error="Gagal." onToggle={() => undefined} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText('Worker orchestrator', { selector: 'section' }).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Gagal.')
  })

  it('shows no env var names or forbidden words', () => {
    render(<CapabilityCard view={view({ status: 'on', detail: 'Berjalan.' })} onToggle={() => undefined} />)
    expect(screen.queryByText(/WEBTERM_|restart|berbahaya/i)).toBeNull()
  })
})
