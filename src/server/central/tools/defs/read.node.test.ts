import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { createNodeReadDefs, type NodeReadDeps } from './read.node'
import { READ_TOOLS_FLAG } from './read.shared'

let f: Fixture
let unregister = (): void => undefined
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => { unregister(); f.close() })

function ctx(deps: NodeReadDeps = {}): ToolCtx {
  const registry = createRegistry()
  createNodeReadDefs(deps).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}
/** The workspace store is a separate file (webterm.db) in production: the ledger fixture has no workspace table. */
function workspace(nodes: unknown): void {
  // Mirrors `Db.get`: the stored blob is parsed on read, so a corrupt blob throws.
  const blob = typeof nodes === 'string' ? nodes : JSON.stringify(nodes)
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: 'Alpha WS', nodes: JSON.parse(blob) as unknown[] } : null))
}

describe('node.list', () => {
  it('lists id/kind/title/agent only, pages, and never leaks cwd, cmd, session or comments', async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      id: `n${i}`, kind: i % 2 ? 'agent' : 'terminal', title: i === 0 ? 'T'.repeat(200) : `node ${i}`,
      agentId: i % 2 ? 'claude' : undefined, cwd: '/home/u/secret', cmd: 'claude --token=abcdefghijk', sessionId: 'sess-1', comments: [{ text: 'c' }],
    }))
    workspace(nodes)
    const first = (await execTool(ctx(), 'node.list', { projectId: 'p1', limit: 10 })).data as { total: number; items: Array<Record<string, unknown>>; nextOffset: number | null; workspace: string }
    expect([first.workspace, first.total, first.items.length, first.nextOffset]).toEqual(['Alpha WS', 25, 10, 10])
    expect(first.items[0]).toEqual({ id: 'n0', name: expect.any(String), kind: 'terminal', title: expect.stringMatching(/truncated\]$/), agentId: null })
    expect(first.items[1]).toMatchObject({ id: 'n1', kind: 'agent', agentId: 'claude' })
    const last = (await execTool(ctx(), 'node.list', { projectId: 'p1', limit: 10, offset: 20 })).data as { items: unknown[]; nextOffset: number | null }
    expect([last.items.length, last.nextOffset]).toEqual([5, null])
    const text = JSON.stringify(first)
    for (const leak of ['/home/u/secret', 'token=', 'sess-1', 'comments']) expect(text).not.toContain(leak)
  })

  it('returns coded failures: no table, no workspace row, corrupt blob, bad paging', async () => {
    expect(await execTool(ctx(), 'node.list', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'workspace_unavailable' })
    workspace('{not json')
    expect(await execTool(ctx(), 'node.list', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'workspace_corrupt' })
    workspace('{"not":"an array"}')
    expect(await execTool(ctx(), 'node.list', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'workspace_corrupt' })
    expect(await execTool(ctx(), 'node.list', { projectId: 'p2' })).toMatchObject({ ok: false, code: 'workspace_not_found' })
    for (const bad of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 'x' }]) {
      expect(await execTool(ctx(), 'node.list', { projectId: 'p1', ...bad })).toMatchObject({ ok: false, code: 'invalid_shape' })
    }
  })

  it('gives every node its unique name: stored ones as-is, missing ones derived like the store does', async () => {
    workspace([{ id: 't1', kind: 'terminal', name: 'Mango' }, { id: 't2', kind: 'terminal', name: 'mango' }, { id: 't3', kind: 'files' }])
    const page = async (offset: number) => ((await execTool(ctx(), 'node.list', { projectId: 'p1', limit: 2, offset })).data as { items: Array<{ name: string }> }).items
    const names = [...await page(0), ...await page(2)].map((i) => i.name)
    expect(names[0]).toBe('Mango')
    expect(names.every((n) => typeof n === 'string' && n !== '')).toBe(true)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3)
  })

  it('reports live for terminal/agent nodes (any pane) and only the host of a browser url', async () => {
    workspace([
      { id: 't1', kind: 'terminal' },
      { id: 't2', kind: 'terminal', panes: { dir: 'h', ratio: 0.5, a: { id: 'p-a' }, b: { id: 'p-b' } } },
      { id: 'a1', kind: 'agent', agentId: 'claude' },
      { id: 'b1', kind: 'browser', url: 'https://github.com/org/repo?token=abc#x' },
      { id: 'b2', kind: 'browser' },
      { id: 'f1', kind: 'files' },
    ])
    const live = new Set(['p-b', 'a1'])
    const res = await execTool(ctx({ live: () => (id) => live.has(id) }), 'node.list', { projectId: 'p1' })
    const items = (res.data as { items: Array<Record<string, unknown>> }).items
    expect(items.map((i) => [i.id, i.live, i.host])).toEqual([
      ['t1', false, undefined], ['t2', true, undefined], ['a1', true, undefined],
      ['b1', undefined, 'github.com'], ['b2', undefined, undefined], ['f1', undefined, undefined],
    ])
    expect(JSON.stringify(items)).not.toContain('token=abc')
  })
})
