// Teardown of nodes CanvasPush.remove took off a board: every node's sessions, plus browser pages.
import { describe, expect, it, vi } from 'vitest'
import type { WsNode } from '../../shared/workspace'
import { sessionIdsOf } from '../../shared/paneSessions'
import { createCanvasTeardown } from './canvasTeardown'

const NODES: WsNode[] = [
  { id: 't1', kind: 'terminal', x: 0, y: 0, panes: { dir: 'v', ratio: 0.5, a: { id: 't1' }, b: { dir: 'h', ratio: 0.5, a: { id: 't1-p2' }, b: { id: 't1-p3' } } } },
  { id: 'b1', kind: 'browser', x: 0, y: 0 },
]

describe('createCanvasTeardown', () => {
  it('ends every node session and closes the page of each browser node', async () => {
    const closeNodes = vi.fn()
    const closeNode = vi.fn(async () => {})
    createCanvasTeardown({ sessions: { closeNodes }, browser: () => ({ closeNode }) })(NODES)
    expect(closeNodes).toHaveBeenCalledWith(NODES)
    expect(closeNode.mock.calls).toEqual([['b1']])
  })

  it('still ends sessions with the browser feature off, and a failed page close does not throw', async () => {
    const closeNodes = vi.fn()
    createCanvasTeardown({ sessions: { closeNodes }, browser: () => null })(NODES)
    expect(closeNodes).toHaveBeenCalledTimes(1)
    const closeNode = vi.fn(async () => { throw new Error('cdp gone') })
    expect(() => createCanvasTeardown({ sessions: { closeNodes }, browser: () => ({ closeNode }) })(NODES)).not.toThrow()
    await Promise.resolve()
    expect(closeNode).toHaveBeenCalledWith('b1')
  })
})

describe('sessionIdsOf (shared by client and server close paths)', () => {
  it('returns every pane leaf left to right, or the node id without panes', () => {
    expect(sessionIdsOf(NODES[0].panes, 't1')).toEqual(['t1', 't1-p2', 't1-p3'])
    expect(sessionIdsOf(undefined, 'b1')).toEqual(['b1'])
  })
})
