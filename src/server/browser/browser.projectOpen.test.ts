import { describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { CanvasAddInput } from '../canvas/canvasPush'
import { openProjectBrowser } from './browser.projectOpen'

const STATE: BrowserState = { id: 'nb1', url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' }

function rig(start: (id: string, ws: string) => Promise<BrowserState> = async () => STATE, addCode?: 'node_exists') {
  const adds: CanvasAddInput[] = []
  const removed: Array<{ workspaceId: string; nodeIds: string[] }> = []
  const deps = {
    canvas: async () => ({
      add: (i: CanvasAddInput) => { adds.push(i); return addCode ? { ok: false as const, code: addCode } : { ok: true as const, updatedAt: 1, nodes: i.nodes } },
      remove: (i: { workspaceId: string; nodeIds: string[] }) => { removed.push(i); return { ok: true as const, workspace: {} as never, removed: [] } },
    }),
    start: vi.fn(start),
    newId: () => 'nb1',
  }
  return { adds, removed, deps }
}

describe('openProjectBrowser', () => {
  it('adds one uncabled browser node to the workspace and starts its page', async () => {
    const r = rig()
    expect(await openProjectBrowser(r.deps, 'w1', () => true)).toEqual({ ok: true, nodeId: 'nb1' })
    expect(r.adds).toEqual([{ workspaceId: 'w1', nodes: [{ id: 'nb1', kind: 'browser', x: 0, y: 0, width: 640, height: 400 }] }])
    expect(r.deps.start).toHaveBeenCalledWith('nb1', 'w1')
  })

  it('refuses when agent control is off, before touching the board', async () => {
    const r = rig()
    expect(await openProjectBrowser(r.deps, 'w1', () => false)).toEqual({ ok: false, code: 'disabled' })
    expect(r.adds).toEqual([])
  })

  it('MAX_LIVE full: browser_limit and the blank node is taken off the board again', async () => {
    const r = rig(async () => { throw new BlockedError('max_live') })
    expect(await openProjectBrowser(r.deps, 'w1', () => true)).toEqual({ ok: false, code: 'browser_limit' })
    expect(r.removed).toEqual([{ workspaceId: 'w1', nodeIds: ['nb1'] }])
  })

  it('any other start failure is launch_failed (node removed); a board refusal passes its code on', async () => {
    const r = rig(async () => { throw new Error('boom') })
    expect(await openProjectBrowser(r.deps, 'w1', () => true)).toEqual({ ok: false, code: 'launch_failed' })
    expect(r.removed).toHaveLength(1)
    expect(await openProjectBrowser(rig(undefined, 'node_exists').deps, 'w1', () => true)).toEqual({ ok: false, code: 'node_exists' })
  })
})
