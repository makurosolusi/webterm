/** @vitest-environment jsdom */
// "Download Chromium" in Settings › Capabilities › Advanced: shown next to the Chromium location only
// when the server supports it; every state (idle, downloading + Cancel, failed + Retry, done) and the
// reload once a download finishes.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { DOWNLOAD_TEXT } from './advancedLabels'
import { AdvancedSection } from './AdvancedSection'
import { DL_IDLE, fakeServer } from './setup/setup.fakeServer'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const advanced = (supported: boolean): CapabilitiesResponse['advanced'] => ({
  agentEngine: { value: 'auto', detected: 'claude' },
  chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] },
  dataDir: '/data',
  chromiumDownload: { supported, state: 'idle', percent: 0 },
  headlessForced: null,
})
const renderSection = (supported: boolean, onChanged = vi.fn(async () => undefined)) => {
  render(<AdvancedSection advanced={advanced(supported)} onChanged={onChanged} open onOpenChange={() => undefined} />)
  return onChanged
}

describe('Settings Download Chromium button', () => {
  it('hidden when the server platform has no build', () => {
    fakeServer()
    renderSection(false)
    expect(screen.queryByRole('button', { name: DOWNLOAD_TEXT.start })).toBeNull()
  })

  it('idle -> downloading with progress and Cancel -> idle', async () => {
    const s = fakeServer()
    renderSection(true)
    expect(screen.getByText(DOWNLOAD_TEXT.checking)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: DOWNLOAD_TEXT.start }))
    expect(await screen.findByRole('progressbar', { name: DOWNLOAD_TEXT.progressLabel })).toBeTruthy()
    expect(screen.getByText(DOWNLOAD_TEXT.progress(0))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: DOWNLOAD_TEXT.cancel }))
    expect(await screen.findByRole('button', { name: DOWNLOAD_TEXT.start })).toBeTruthy()
    expect(s.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/capabilities/chromium-download', 'POST /api/capabilities/chromium-download', 'POST /api/capabilities/chromium-download/cancel',
    ])
  })

  it('a finished download shows the path and reloads the capabilities once', async () => {
    const s = fakeServer({ download: { ...DL_IDLE, state: 'downloading', percent: 90 } })
    const onChanged = renderSection(true)
    expect(await screen.findByText(DOWNLOAD_TEXT.progress(90))).toBeTruthy()
    s.download = { ...DL_IDLE, state: 'done', percent: 100, executablePath: '/data/browsers/chrome/x/chrome' }
    expect(await screen.findByText('/data/browsers/chrome/x/chrome', {}, { timeout: 2000 })).toBeTruthy()
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: DOWNLOAD_TEXT.start })).toBeNull()
  })

  it('a failed download shows the reason with Retry, which starts again', async () => {
    const s = fakeServer({ download: { ...DL_IDLE, state: 'failed', error: 'Chromium could not be downloaded.' } })
    renderSection(true)
    expect((await screen.findByRole('alert')).textContent).toBe('Chromium could not be downloaded.')
    fireEvent.click(screen.getByRole('button', { name: DOWNLOAD_TEXT.retry }))
    expect(await screen.findByRole('button', { name: DOWNLOAD_TEXT.cancel })).toBeTruthy()
    expect(s.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/capabilities/chromium-download' })
  })
})
