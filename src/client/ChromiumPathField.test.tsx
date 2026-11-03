/** @vitest-environment jsdom */
// Lokasi Chromium: path otomatis tampil, kandidat bisa dipilih lalu disimpan, "Pakai otomatis" menghapus override.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { ChromiumPathField } from './ChromiumPathField'

type Chromium = CapabilitiesResponse['advanced']['chromiumPath']
// test-only
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const auto: Chromium = { value: '', detected: true, active: CHROME, source: 'auto', overrideInvalid: false, candidates: [CHROME, BRAVE] }

afterEach(cleanup)

const setup = (chromium: Chromium) => {
  const save = vi.fn(async (_p: string) => undefined)
  const redetect = vi.fn(async () => undefined)
  render(<ChromiumPathField chromium={chromium} save={save} redetect={redetect} />)
  return { save, redetect }
}

describe('ChromiumPathField', () => {
  it('shows the auto-detected path as status and placeholder; no "Pakai otomatis" without override', () => {
    setup(auto)
    expect(screen.getByRole('status').textContent).toBe(`Dipakai (otomatis): ${CHROME}`)
    expect(screen.getByLabelText('Lokasi Chromium').getAttribute('placeholder')).toBe(`Otomatis: ${CHROME}`)
    expect(screen.queryByRole('button', { name: 'Pakai otomatis' })).toBeNull()
  })

  it('picking a candidate fills the input; Simpan lokasi saves it', () => {
    const { save } = setup(auto)
    const list = screen.getByRole('list', { name: 'Ditemukan di komputer ini' })
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([CHROME, BRAVE])
    const save_ = screen.getByRole('button', { name: 'Simpan lokasi' }) as HTMLButtonElement
    expect(save_.disabled).toBe(true)
    fireEvent.click(within(list).getByRole('button', { name: BRAVE }))
    expect((screen.getByLabelText('Lokasi Chromium') as HTMLInputElement).value).toBe(BRAVE)
    expect(within(list).getByRole('button', { name: BRAVE }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(save_)
    expect(save).toHaveBeenCalledWith(BRAVE)
  })

  it('override active: labelled as yours, "Pakai otomatis" saves an empty path', () => {
    const { save } = setup({ ...auto, value: BRAVE, active: BRAVE, source: 'override' })
    expect(screen.getByRole('status').textContent).toBe(`Dipakai (pilihan Anda): ${BRAVE}`)
    fireEvent.click(screen.getByRole('button', { name: 'Pakai otomatis' }))
    expect(save).toHaveBeenCalledWith('')
  })

  it('invalid override is reported; Deteksi ulang reloads', () => {
    const { redetect } = setup({ ...auto, value: '/opt/gone', detected: false, active: null, source: null, overrideInvalid: true })
    expect(screen.getByRole('status').textContent).toContain('Lokasi pilihan Anda tidak ditemukan')
    fireEvent.click(screen.getByRole('button', { name: 'Deteksi ulang' }))
    expect(redetect).toHaveBeenCalledTimes(1)
  })

  it('nothing found: missing text, default placeholder, no candidate list', () => {
    setup({ value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] })
    expect(screen.getByRole('status').textContent).toBe('Chromium belum ditemukan. Isi lokasinya di sini.')
    expect(screen.getByLabelText('Lokasi Chromium').getAttribute('placeholder')).toBe('Jalur ke aplikasi Chromium')
    expect(screen.queryByRole('list')).toBeNull()
  })
})
