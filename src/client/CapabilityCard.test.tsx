/** @vitest-environment jsdom */
// Kartu kemampuan: satu switch, status, langkah, "Also turns on/off", sub-opsi hanya saat aktif.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    expect(screen.getByRole('status').textContent).toContain('On')
  })

  it('shows Mati for off', () => {
    render(<CapabilityCard view={view({})} onToggle={() => undefined} />)
    expect(screen.getByRole('status').textContent).toContain('Off')
  })

  it('needs-step shows the step button; the switch stays usable to turn the feature OFF', () => {
    const onStep = vi.fn()
    const onToggle = vi.fn()
    render(<CapabilityCard view={view({ id: 'browser', status: 'needs-step', step: { kind: 'chromiumPath', label: 'Pilih lokasi' } })} onToggle={onToggle} onStep={onStep} />)
    expect(screen.getByRole('status').textContent).toContain('Needs one step')
    const sw = screen.getByRole('switch') as HTMLButtonElement
    expect(sw.disabled).toBe(false)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(onToggle).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Pilih lokasi' }))
    expect(onStep).toHaveBeenCalledWith('chromiumPath')
  })

  it('lists what turns on before the click (server field)', () => {
    render(<CapabilityCard view={view({ id: 'autonomy', title: 'Central Agent autonomy', alsoTurnsOn: ['central', 'workers'] })} onToggle={() => undefined} />)
    expect(screen.getByText(/Also turns on: Central Agent, Worker orchestrator/)).toBeTruthy()
  })

  it('lists what turns off while on (dependents that are on)', () => {
    const all = [view({ id: 'central', title: 'Central Agent', status: 'on' }), view({ status: 'on' }), view({ id: 'autonomy', status: 'off' })]
    render(<CapabilityCard view={all[0]} all={all} onToggle={() => undefined} />)
    expect(screen.getByText(/Also turns off: Worker orchestrator$/)).toBeTruthy()
  })

  it('hides sub-options when off and shows them (not as switches) when on', () => {
    const subs = [{ key: 'K', label: 'Ask for approval before a worker runs', on: true }]
    const { rerender } = render(<CapabilityCard view={view({ subs })} onToggle={() => undefined} />)
    expect(screen.queryByText(/Minta persetujuan/)).toBeNull()
    const onSub = vi.fn()
    rerender(<CapabilityCard view={view({ status: 'on', subs })} onToggle={() => undefined} onSub={onSub} />)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    fireEvent.click(screen.getByRole('checkbox', { name: /Ask for approval/ }))
    expect(onSub).toHaveBeenCalledWith('K', false)
  })

  // The app AlertDialog asks; Cancel leaves it off, "Turn on" goes through. window.confirm is never used.
  const dialog = () => screen.getByRole('alertdialog')
  const answer = (name: 'Cancel' | 'Turn on') => fireEvent.click(within(dialog()).getByRole('button', { name }))

  it('dangerous sub: turning on asks in the app dialog (Cancel = unchanged), turning off never asks', () => {
    const label = 'Let agents drive the browser'
    const sub = (on: boolean) => [{ key: 'browserAgent', label, on, dangerous: true }]
    const onSub = vi.fn()
    const confirm = vi.spyOn(window, 'confirm')
    const { rerender } = render(<CapabilityCard view={view({ id: 'browser', status: 'on', subs: sub(false) })} onToggle={() => undefined} onSub={onSub} />)
    fireEvent.click(screen.getByRole('checkbox', { name: label }))
    expect(dialog().textContent).toContain(label)
    answer('Cancel')
    expect(onSub).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: label }))
    answer('Turn on')
    expect(onSub).toHaveBeenCalledWith('browserAgent', true)
    rerender(<CapabilityCard view={view({ id: 'browser', status: 'on', subs: sub(true) })} onToggle={() => undefined} onSub={onSub} />)
    fireEvent.click(screen.getByRole('checkbox', { name: label }))
    expect(onSub).toHaveBeenLastCalledWith('browserAgent', false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('Autonomy: turning on (switch or fixChain step) asks in the dialog; turning off does not', () => {
    const onToggle = vi.fn()
    const onStep = vi.fn()
    const otonomi = (o: Partial<CapabilityView>) => view({ id: 'autonomy', title: 'Central Agent autonomy', ...o })
    const { rerender } = render(<CapabilityCard view={otonomi({})} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(dialog().textContent).toContain('Central Agent autonomy')
    answer('Cancel')
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch'))
    answer('Turn on')
    expect(onToggle).toHaveBeenCalledWith(true)
    rerender(<CapabilityCard view={otonomi({ status: 'needs-step', step: { kind: 'fixChain', label: 'Turn on what’s needed' } })} onToggle={onToggle} onStep={onStep} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on what’s needed' }))
    answer('Cancel')
    expect(onStep).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch')) // needs-step shows on: a click turns it off, no question
    expect(onToggle).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a sub-option slot (Files › Edit files) shows only while the card is on', () => {
    const { rerender } = render(<CapabilityCard view={view({ id: 'files' })} onToggle={() => undefined}><span>Edit and upload files</span></CapabilityCard>)
    expect(screen.queryByText('Edit and upload files')).toBeNull()
    rerender(<CapabilityCard view={view({ id: 'files', status: 'on' })} onToggle={() => undefined}><span>Edit and upload files</span></CapabilityCard>)
    expect(screen.getByText('Edit and upload files')).toBeTruthy()
  })

  it('kartu biasa menyala tanpa konfirmasi', () => {
    const confirm = vi.spyOn(window, 'confirm')
    const onToggle = vi.fn()
    render(<CapabilityCard view={view({})} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onToggle).toHaveBeenCalledWith(true)
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('sub biasa tidak pernah minta konfirmasi', () => {
    const confirm = vi.spyOn(window, 'confirm')
    const onSub = vi.fn()
    render(<CapabilityCard view={view({ status: 'on', subs: [{ key: 'K', label: 'Minta persetujuan', on: false }] })} onToggle={() => undefined} onSub={onSub} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Minta persetujuan' }))
    expect(onSub).toHaveBeenCalledWith('K', true)
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
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
