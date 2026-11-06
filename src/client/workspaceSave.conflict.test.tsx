/**
 * @vitest-environment jsdom
 */
// The real App against a server that refuses the board save: 409 (another window saved first)
// reloads the stored board and says so; 404 (deleted elsewhere) drops the save and says so.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { HARNESS_WS_ID, harnessWorkspace, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { DELETED_NOTICE, STALE_RELOADED_NOTICE } from './workspaceSave.notice'
import type { Workspace } from '../shared/workspace'

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

/** The board another window stored meanwhile: newer version, no nodes. */
const current = harnessWorkspace({ id: HARNESS_WS_ID, name: 'harness', updatedAt: 50 }) // test-only

const isBoardPut = (input: RequestInfo | URL, init?: RequestInit) =>
  init?.method === 'PUT' && String(input).startsWith('/api/workspaces/')

/** Answer board PUTs with `answer(n)` (n = 0-based PUT count); everything else as the harness does. */
function refusePuts(answer: (n: number, body: Workspace) => { status: number; body: unknown }): Workspace[] {
  const base = fetch as unknown as Mock
  const sent: Workspace[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isBoardPut(input, init)) return base(input, init)
    const body = JSON.parse(String(init?.body)) as Workspace
    const r = answer(sent.length, body)
    sent.push(body)
    return Promise.resolve({ ok: r.status < 300, status: r.status, json: async () => r.body } as Response)
  }))
  return sent
}

async function addTerminal(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Add node'))
  fireEvent.click(await screen.findByRole('option', { name: 'Terminal' }))
}

/** Debounce (400ms) + a loaded CI machine; the wait ends as soon as the notice shows. */
const NOTICE_WAIT_MS = 10_000

const nodeCount = () => document.querySelectorAll('.react-flow__node').length

describe('board save refused by the server', () => {
  it('409: reloads the stored board, shows the notice, and the next save is based on it', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    const sent = refusePuts((n, body) => n === 0
      ? { status: 409, body: { code: 'stale', current } }
      : { status: 200, body: { ...body, updatedAt: body.updatedAt + 1 } })
    await addTerminal()
    await waitFor(() => expect(nodeCount()).toBe(1))

    expect(await screen.findByText(STALE_RELOADED_NOTICE, {}, { timeout: NOTICE_WAIT_MS })).toBeTruthy()
    expect(sent[0].updatedAt).toBe(0) // the precondition is the loaded version, not Date.now()
    await waitFor(() => expect(nodeCount()).toBe(0), { timeout: NOTICE_WAIT_MS }) // the stored board replaced the unsaved one

    await addTerminal()
    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2), { timeout: NOTICE_WAIT_MS })
    expect(sent[1].updatedAt).toBe(current.updatedAt)
  })

  it('404: drops the save and shows that the workspace was deleted elsewhere', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    const sent = refusePuts(() => ({ status: 404, body: { error: 'not found' } }))
    await addTerminal()
    expect(await screen.findByText(DELETED_NOTICE, {}, { timeout: NOTICE_WAIT_MS })).toBeTruthy()
    await addTerminal() // a later edit on the deleted board
    await act(() => new Promise<void>((r) => setTimeout(r, 1000)))
    expect(sent).toHaveLength(1) // no retry, no re-create
  })
})
