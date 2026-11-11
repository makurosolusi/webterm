/** @vitest-environment jsdom */
// The real App under the URL contract (./appRoute): the URL's board wins at boot, the URL follows
// the board, Back/Forward switch it, and overlays open from (and write back to) search params.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HARNESS_WS_ID, harnessNavigate, harnessUrl, harnessWorkspace, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

const OTHER = harnessWorkspace({ id: 'ws-2', name: 'second' }) // test-only
const fx = (url?: string) => ({ nodes: [], dirs: {}, others: [OTHER], url })
const calls = () => vi.mocked(fetch).mock.calls.map(([u, init]) => `${init?.method ?? 'GET'} ${String(u)}`)
const putActive = () => vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u) === '/api/active' && init?.method === 'PUT').map(([, init]) => String(init?.body))

describe('board in the URL', () => {
  it('a bare `/` opens the server active board and writes its id into the URL', async () => {
    await mountCanvas(fx('/'))
    await waitFor(() => expect(harnessUrl).toBe(`/w/${HARNESS_WS_ID}`))
    expect(putActive()).toEqual([])
  })

  it('`/w/:id` wins over the server active board and becomes the active one', async () => {
    await mountCanvas(fx('/w/ws-2'))
    expect(calls()).toContain('GET /api/workspaces/ws-2')
    expect(putActive().join()).toContain('ws-2')
    expect(harnessUrl).toBe('/w/ws-2')
  })

  it('an unknown id falls back to the active board and the URL is replaced', async () => {
    await mountCanvas(fx('/w/nope?settings=canvas&help=yes'))
    await waitFor(() => expect(harnessUrl).toBe(`/w/${HARNESS_WS_ID}?settings=canvas`))
    expect(calls()).not.toContain('GET /api/workspaces/nope')
  })

  it('an unknown path redirects to `/`, then to the active board', async () => {
    await mountCanvas(fx('/nowhere/at/all'))
    await waitFor(() => expect(harnessUrl).toBe(`/w/${HARNESS_WS_ID}`))
  })

  it('changing the URL (Back/Forward, a link) switches board without remounting App', async () => {
    await mountCanvas(fx('/'))
    await waitFor(() => expect(harnessUrl).toBe(`/w/${HARNESS_WS_ID}`))
    await act(async () => { harnessNavigate!('/w/ws-2') })
    await waitFor(() => expect(putActive().join()).toContain('ws-2'))
    expect(calls().filter((c) => c === 'GET /api/workspaces')).toHaveLength(1) // a remount would boot again
  })
})

describe('overlays in the URL', () => {
  it('`?settings=` opens Settings over the board; closing drops the param', async () => {
    await mountCanvas(fx(`/w/${HARNESS_WS_ID}?settings=canvas`))
    const close = await screen.findByRole('button', { name: 'Close settings' })
    expect(document.querySelector('.react-flow__pane')).not.toBeNull() // the canvas stays mounted underneath
    fireEvent.click(close)
    await waitFor(() => expect(harnessUrl).toBe(`/w/${HARNESS_WS_ID}`))
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull()
  })

  it('Back closes Settings opened from the app', async () => {
    await mountCanvas(fx(`/w/${HARNESS_WS_ID}`))
    fireEvent.click(screen.getAllByRole('button', { name: /^Settings/ })[0])
    await waitFor(() => expect(harnessUrl).toBe(`/w/${HARNESS_WS_ID}?settings=terminal`))
    await act(async () => { harnessNavigate!(-1) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull())
  })
})
