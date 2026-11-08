/** @vitest-environment jsdom */
// Chromium location: path otomatis tampil, kandidat jadi saran combobox dan tersimpan saat dipilih, "Use automatic" menghapus override.
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
  it('shows the auto-detected path as status and placeholder; no "Use automatic" without override', () => {
    setup(auto)
    expect(screen.getByRole('status').textContent).toBe(`In use (automatic): ${CHROME}`)
    expect(screen.getByLabelText('Chromium location').getAttribute('placeholder')).toBe(`Automatic: ${CHROME}`)
    expect(screen.queryByRole('button', { name: 'Use automatic' })).toBeNull()
  })

  it('candidates are combobox suggestions; picking one saves it, a typed path saves on Enter', () => {
    const { save } = setup(auto)
    const input = screen.getByRole('combobox', { name: 'Chromium location' }) as HTMLInputElement
    fireEvent.click(screen.getByRole('button', { name: 'Show suggestions' }))
    const list = screen.getByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([CHROME, BRAVE])
    fireEvent.click(within(list).getByRole('option', { name: BRAVE }))
    expect(input.value).toBe(BRAVE)
    expect(save).toHaveBeenCalledWith(BRAVE)
    fireEvent.change(input, { target: { value: ' /opt/chromium ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(save).toHaveBeenLastCalledWith('/opt/chromium')
  })

  it('override active: labelled as yours, "Use automatic" saves an empty path', () => {
    const { save } = setup({ ...auto, value: BRAVE, active: BRAVE, source: 'override' })
    expect(screen.getByRole('status').textContent).toBe(`In use (your choice): ${BRAVE}`)
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic' }))
    expect(save).toHaveBeenCalledWith('')
  })

  it('invalid override is reported; Detect again reloads', () => {
    const { redetect } = setup({ ...auto, value: '/opt/gone', detected: false, active: null, source: null, overrideInvalid: true })
    expect(screen.getByRole('status').textContent).toContain('The location you chose was not found')
    fireEvent.click(screen.getByRole('button', { name: 'Detect again' }))
    expect(redetect).toHaveBeenCalledTimes(1)
  })

  it('nothing found: missing text, default placeholder, no candidate list', () => {
    setup({ value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] })
    expect(screen.getByRole('status').textContent).toBe('Chromium was not found. Enter its location here.')
    expect(screen.getByLabelText('Chromium location').getAttribute('placeholder')).toBe('Path to the Chromium app')
    fireEvent.click(screen.getByRole('button', { name: 'Show suggestions' }))
    expect(screen.queryByRole('option')).toBeNull()
  })
})
