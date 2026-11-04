/** @vitest-environment jsdom */
// Chromium location: path otomatis tampil, kandidat bisa dipilih lalu disimpan, "Use automatic" menghapus override.
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

  it('picking a candidate fills the input; Save location saves it', () => {
    const { save } = setup(auto)
    const list = screen.getByRole('list', { name: 'Found on this computer' })
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([CHROME, BRAVE])
    const save_ = screen.getByRole('button', { name: 'Save location' }) as HTMLButtonElement
    expect(save_.disabled).toBe(true)
    fireEvent.click(within(list).getByRole('button', { name: BRAVE }))
    expect((screen.getByLabelText('Chromium location') as HTMLInputElement).value).toBe(BRAVE)
    expect(within(list).getByRole('button', { name: BRAVE }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(save_)
    expect(save).toHaveBeenCalledWith(BRAVE)
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
    expect(screen.queryByRole('list')).toBeNull()
  })
})
