/**
 * @vitest-environment jsdom
 */
// The sessions panel closing a node of a workspace that is NOT open (workspaceLifecycle.ts
// `closeSession`): that node is not on the canvas, so React Flow's `onBeforeDelete` never sees it
// and the lifecycle asks the same confirm itself. Real App, only `fetch` and `send` stubbed.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { confirmNodeCloseDialog, harnessWorkspace, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import type { Workspace, WsNode } from '../shared/workspace'

const { sent } = vi.hoisted(() => ({ sent: [] as { t: string; id: string }[] }))
vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: (m: { t: string; id: string }) => { sent.push(m) } }
})

// test-only fixtures: a split terminal (two PTYs) in the workspace that is not open.
const here: WsNode = { id: 'files-here', kind: 'files', x: 0, y: 0, width: 420, height: 320, dirPath: '/q', title: 'here' }
const there: WsNode = {
  id: 'term-there', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'there',
  panes: { dir: 'h', ratio: 0.5, a: { id: 'term-there' }, b: { id: 'term-there:p2' } },
}

beforeAll(installCanvasDom)
beforeEach(() => { sent.length = 0 })
afterEach(unmountCanvas)

/** Bodies of every PUT to the other workspace: the off-canvas close persists through one. */
const putsToOther = (): Workspace[] =>
  (fetch as unknown as Mock).mock.calls
    .filter(([url, init]) => String(url) === '/api/workspaces/ws-other' && (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Workspace)
const dialog = () => document.querySelector('[data-slot="vscode-dialog"]')
const closes = () => sent.filter((m) => m.t === 'close').map((m) => m.id).sort()

async function mountWithOther(): Promise<void> {
  await mountCanvas({ nodes: [here], dirs: { '/q': [] }, others: [harnessWorkspace({ id: 'ws-other', name: 'Other', nodes: [there] })] })
  fireEvent.click(await screen.findByLabelText('End session there'))
  await waitFor(() => expect(dialog()).not.toBeNull())
  expect(screen.getByText('Close “there”?')).toBeTruthy()
}

describe('off-workspace close from the sessions panel', () => {
  it('Cancel ends no session and keeps the node in that workspace', async () => {
    await mountWithOther()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(() => new Promise<void>((r) => setTimeout(r, 20)))
    expect(dialog()).toBeNull()
    expect(closes()).toEqual([])
    expect(putsToOther()).toEqual([])
    expect(screen.getByLabelText('End session there')).toBeTruthy()
  })

  it('Close ends every pane session and saves the workspace without the node', async () => {
    await mountWithOther()
    await confirmNodeCloseDialog()
    await waitFor(() => expect(closes()).toEqual(['term-there', 'term-there:p2']))
    await waitFor(() => expect(putsToOther()).toHaveLength(1))
    expect(putsToOther()[0].nodes.map((n) => n.id)).toEqual([])
  })
})
