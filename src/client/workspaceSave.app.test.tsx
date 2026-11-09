/**
 * @vitest-environment jsdom
 */
// The real App against a server that fails, comes back, and keeps what it is sent:
// - a failed board save stays unsaved, says so with Retry, blocks leaving, and Retry resends it;
// - leaving the page writes the debounced save at once, as a keepalive request;
// - the workspace list the Sessions panel and notification focus read follows the saves.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { HARNESS_WS_ID, harnessWorkspace, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { SAVE_RECOVERED_NOTICE, saveFailedNotice } from './workspaceSave.notice'
import { UNSAVED_STATUS_LABEL } from './workspaceSave.status'
import * as osNotify from './osNotify'
import type { Workspace, WsNode } from '../shared/workspace'

beforeAll(installCanvasDom)
beforeEach(() => { // side bar open on the Sessions view
  localStorage.setItem('webterm.sessionsPinned', '1')
  localStorage.setItem('webterm.sideBarView', 'sessions')
})
afterEach(() => { unmountCanvas(); vi.restoreAllMocks(); localStorage.clear() })

/** Debounce (400ms) + a loaded CI machine; each wait ends as soon as its condition holds. */
const WAIT = { timeout: 10_000 }

const isBoardPut = (input: RequestInfo | URL, init?: RequestInit) =>
  init?.method === 'PUT' && String(input).startsWith('/api/workspaces/')

/** A server that stores board PUTs (answering 500 while `down`) and serves them back on GET. */
function statefulServer() {
  const base = fetch as unknown as Mock
  const stored = new Map<string, Workspace>()
  const srv = { down: false, puts: [] as { body: Workspace; init: RequestInit }[], stored }
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const id = decodeURIComponent(url.slice('/api/workspaces/'.length))
    if (isBoardPut(input, init)) {
      const body = JSON.parse(String(init?.body)) as Workspace
      srv.puts.push({ body, init: init! })
      if (srv.down) return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'db is locked' }) } as Response)
      const saved = { ...body, updatedAt: body.updatedAt + 1 }
      stored.set(saved.id, saved)
      return Promise.resolve({ ok: true, status: 200, json: async () => saved } as Response)
    }
    if (url.startsWith('/api/workspaces/') && !init?.method && stored.has(id)) {
      return Promise.resolve({ ok: true, status: 200, json: async () => stored.get(id) } as Response)
    }
    return base(input, init)
  }))
  return srv
}

async function addTerminal(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Add node'))
  fireEvent.click(await screen.findByRole('option', { name: 'Terminal' }))
}

/** The notification card holding `title`. */
const noticeOf = (title: string): HTMLElement => screen.getByText(title).closest('.vscode-notification') as HTMLElement

const nodeCount = () => document.querySelectorAll('.react-flow__node').length
const terminalsIn = (ws: Workspace | undefined): WsNode[] => (ws?.nodes ?? []).filter((n) => n.kind === 'terminal')

describe('board save failing and recovering (real App)', () => {
  it('keeps the change unsaved with a sticky Retry notice, blocks leaving, and Retry resends it', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    const srv = statefulServer()
    srv.down = true
    await addTerminal()
    expect(await screen.findByText(saveFailedNotice('harness'), {}, WAIT)).toBeTruthy()
    expect(screen.getByText(/db is locked/)).toBeTruthy() // the cause, from the server
    expect(screen.getByLabelText(`${UNSAVED_STATUS_LABEL}: retry saving`)).toBeTruthy()

    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true) // the browser asks before discarding it

    srv.down = false
    fireEvent.click(within(noticeOf(saveFailedNotice('harness'))).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(SAVE_RECOVERED_NOTICE, {}, WAIT)).toBeTruthy()
    expect(srv.puts.length).toBeGreaterThanOrEqual(2)
    expect(srv.puts.at(-1)!.body.nodes).toEqual(srv.puts[0].body.nodes) // the same change, resent
    expect(terminalsIn(srv.stored.get(HARNESS_WS_ID))).toHaveLength(1)
    expect(screen.queryByLabelText(`${UNSAVED_STATUS_LABEL}: retry saving`)).toBeNull()

    const leaveAgain = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaveAgain)
    expect(leaveAgain.defaultPrevented).toBe(false)
  })

  it('pagehide writes the debounced save at once as a keepalive request with the latest board', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    const srv = statefulServer()
    await addTerminal()
    // Same task as the click: no timer can have run, so the 400ms debounce has not fired yet.
    expect(srv.puts).toHaveLength(0)
    window.dispatchEvent(new Event('pagehide'))
    expect(srv.puts).toHaveLength(1)
    expect(srv.puts[0].init.keepalive).toBe(true)
    expect(terminalsIn(srv.puts[0].body)).toHaveLength(1)
    await waitFor(() => expect(nodeCount()).toBe(1))
  })
})

describe('workspace list follows the saves (real App)', () => {
  const there: WsNode = { id: 'files-there', kind: 'files', x: 0, y: 0, width: 420, height: 320, dirPath: '/q', title: 'there' }

  it('a session added before switching shows in the Sessions panel and a notification for it switches back', async () => {
    const install = vi.spyOn(osNotify, 'setNotifyCanvas')
    await mountCanvas({ nodes: [], dirs: { '/q': [] }, others: [harnessWorkspace({ id: 'ws-other', name: 'Other', nodes: [there] })] })
    const srv = statefulServer()
    const focus = () => install.mock.calls.map(([h]) => h.focus).filter(Boolean).at(-1)!

    await addTerminal()
    await waitFor(() => expect(srv.stored.has(HARNESS_WS_ID)).toBe(true), WAIT)
    const added = terminalsIn(srv.stored.get(HARNESS_WS_ID))[0]

    act(() => focus()('files-there')) // to the other board
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="files-there"]')).not.toBeNull(), WAIT)
    // The row of the board left behind, labelled by the node's saved name and its kind.
    expect(screen.getAllByLabelText(`End session ${added.name} · Terminal`)).toHaveLength(1)

    act(() => focus()(added.id)) // its owner is found in the list, not the boot snapshot
    await waitFor(() => expect(document.querySelector(`.react-flow__node[data-id="${added.id}"]`)).not.toBeNull(), WAIT)
  })
})
