/**
 * @vitest-environment jsdom
 */
// The real App when a workspace action fails: a sticky notice with the cause and Retry, no
// unhandled rejection (vitest fails the run on one), and Retry runs the action again.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { harnessWorkspace, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { ACTION_RETRY_LABEL } from './workspaceActionError'
import * as osNotify from './osNotify'
import type { WsNode } from '../shared/workspace'

beforeAll(installCanvasDom)
afterEach(() => { unmountCanvas(); vi.restoreAllMocks() })

const WAIT = { timeout: 10_000 }
const there: WsNode = { id: 'files-there', kind: 'files', x: 0, y: 0, width: 420, height: 320, dirPath: '/q', title: 'there' }

describe('failed workspace action (real App)', () => {
  it('a notification focus whose board fails to load says so with Retry, and Retry switches', async () => {
    const install = vi.spyOn(osNotify, 'setNotifyCanvas')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mountCanvas({ nodes: [], dirs: { '/q': [] }, others: [harnessWorkspace({ id: 'ws-other', name: 'Other', nodes: [there] })] })
    const base = fetch as unknown as Mock
    let down = true
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      down && String(input) === '/api/workspaces/ws-other' && !init?.method
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'disk I/O error' }) } as Response)
        : base(input, init)))
    const focus = install.mock.calls.map(([h]) => h.focus).filter(Boolean).at(-1)!

    act(() => focus('files-there'))
    const title = await screen.findByText('Could not show the session.', {}, WAIT)
    expect(screen.getByText(/disk I\/O error/)).toBeTruthy()
    expect(console.error).toHaveBeenCalledWith('[webterm] show the session (files-there) failed:', expect.any(Error))

    down = false
    fireEvent.click(within(title.closest('.vscode-notification') as HTMLElement).getByRole('button', { name: ACTION_RETRY_LABEL }))
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="files-there"]')).not.toBeNull(), WAIT)
  })
})
