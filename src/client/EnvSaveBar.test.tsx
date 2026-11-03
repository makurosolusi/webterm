/**
 * @vitest-environment jsdom
 */
// Bar simpan: muncul sesuai dirty, simpan massal, Buang, konfirmasi dangerous, status "Tersimpan", fokus.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvSaveBar } from './EnvSaveBar'
import { baseState, EnvHarness, putBodies, stubEnvApi } from './envTestFixtures'
import { useEnvSettingsContext } from './useEnvSettings'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Tombol uji yang menulis draft lewat provider (pengganti baris). */
function Drafter(): React.JSX.Element {
  const api = useEnvSettingsContext()
  return (
    <>
      <button type="button" onClick={() => api.setDraft('K_ONE', 'on')}>d-one</button>
      <button type="button" onClick={() => api.setDraft('K_TWO', 'x')}>d-two</button>
      <button type="button" onClick={() => api.setDraft('K_DANGER', 'on')}>d-danger</button>
    </>
  )
}
const mount = (): ReturnType<typeof stubEnvApi> => {
  const stub = stubEnvApi(baseState())
  render(<EnvHarness><Drafter /><EnvSaveBar /></EnvHarness>)
  return stub
}
const ready = async (): Promise<void> => { await waitFor(() => expect(screen.getByText('d-one')).toBeTruthy()); await new Promise((r) => setTimeout(r, 20)) }

describe('EnvSaveBar', () => {
  it('is empty without drafts and shows N perubahan with drafts', async () => {
    mount()
    await ready()
    expect(screen.queryByRole('group', { name: 'Perubahan belum disimpan' })).toBeNull()
    fireEvent.click(screen.getByText('d-one'))
    fireEvent.click(screen.getByText('d-two'))
    expect(screen.getByText('2 perubahan belum disimpan')).toBeTruthy()
  })

  it('saves everything in one PUT, announces Tersimpan and moves focus', async () => {
    const stub = mount()
    await ready()
    stub.getState = { ...stub.getState, entries: stub.getState.entries.map((e) => (e.key === 'K_ONE' ? { ...e, value: 'on' } : e.key === 'K_TWO' ? { ...e, value: 'x' } : e)) }
    fireEvent.click(screen.getByText('d-one'))
    fireEvent.click(screen.getByText('d-two'))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Tersimpan'))
    expect(putBodies(stub)).toEqual([{ set: { K_ONE: 'on', K_TWO: 'x' } }])
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('status').parentElement)
  })

  it('Buang clears drafts without any PUT', async () => {
    const stub = mount()
    await ready()
    fireEvent.click(screen.getByText('d-one'))
    fireEvent.click(screen.getByRole('button', { name: 'Buang' }))
    expect(screen.queryByText(/perubahan belum disimpan/)).toBeNull()
    expect(putBodies(stub)).toEqual([])
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('asks for confirmation before saving a dangerous key, with its human label', async () => {
    const stub = mount()
    await ready()
    fireEvent.click(screen.getByText('d-danger'))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    expect(putBodies(stub)).toEqual([])
    expect(screen.getByText('Pengaturan berbahaya akan diubah: Mode bahaya. Lanjutkan?')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ya, simpan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Batal' }))
    expect(putBodies(stub)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ya, simpan' }))
    await waitFor(() => expect(putBodies(stub)).toEqual([{ set: { K_DANGER: 'on' } }]))
  })

  it('does not announce Tersimpan and keeps the bar when the PUT fails', async () => {
    const stub = mount()
    await ready()
    stub.put = () => ({ status: 500, body: { error: 'store_failed' } })
    fireEvent.click(screen.getByText('d-one'))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Simpan' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByText('1 perubahan belum disimpan')).toBeTruthy()
  })
})
