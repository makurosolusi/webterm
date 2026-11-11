/**
 * @vitest-environment jsdom
 */
// The real App when the first workspace load fails: the cause and a Retry instead of a blank page,
// and the board once the server answers (Retry or the automatic retry).
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountHeld, unmountCanvas } from './canvasHarness'
import { BOOT_FAILED_TITLE } from './BootScreen'
import { SETUP_TEXT } from './setup/setup.labels'
import { resetSetupAutoOpen } from './App.setup'

const boot = vi.hoisted(() => ({ failures: 0, calls: 0 }))
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>()
  return {
    ...real,
    fetchWorkspaces: () => {
      boot.calls++
      if (boot.failures > 0) { boot.failures--; return Promise.reject(new Error('GET /api/workspaces -> 502: bad gateway')) }
      return real.fetchWorkspaces()
    },
  }
})

beforeAll(installCanvasDom)
afterEach(() => { unmountCanvas(); resetSetupAutoOpen(); vi.restoreAllMocks(); boot.calls = 0; boot.failures = 0 })

/** Automatic retry after the first failure is `reconnectDelay(0)`; generous for a loaded CI machine. */
const WAIT = { timeout: 10_000 }
const canvasMounted = () => expect(document.querySelector('.react-flow__pane')).not.toBeNull()

describe('workspace boot failure (real App)', () => {
  it('shows the cause and a Retry, and Retry loads the board', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot.failures = 1
    await mountHeld({ nodes: [], dirs: {} })()
    expect(await screen.findByText(BOOT_FAILED_TITLE)).toBeTruthy()
    expect(screen.getByText(/502: bad gateway/)).toBeTruthy()
    expect(document.querySelector('.react-flow__pane')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(canvasMounted, WAIT)
    expect(boot.calls).toBe(2)
    expect(screen.queryByText(BOOT_FAILED_TITLE)).toBeNull()
  })

  it('retries on its own while the server is coming back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot.failures = 1
    await mountHeld({ nodes: [], dirs: {} })()
    expect(await screen.findByText(BOOT_FAILED_TITLE)).toBeTruthy()
    await waitFor(canvasMounted, WAIT)
    expect(boot.calls).toBe(2)
  })

  it('keeps the first-run wizard off the boot error, and opens it once Retry loads the board', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot.failures = 1
    const wizard = () => screen.queryByRole('dialog', { name: SETUP_TEXT.title })
    await mountHeld({ nodes: [], dirs: {}, settings: { setup: { completedAt: null, steps: {} } } })() // test-only: unfinished setup
    expect(await screen.findByText(BOOT_FAILED_TITLE)).toBeTruthy()
    expect(wizard()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(canvasMounted, WAIT)
    await waitFor(() => expect(wizard()).not.toBeNull(), WAIT)
  })
})
