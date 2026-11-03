import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { NODE_READ_DEFS } from './read.node'
import { READ_TOOLS_FLAG } from './read.shared'

let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

function ctx(): ToolCtx {
  const registry = createRegistry()
  NODE_READ_DEFS.forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}
function workspace(nodes: unknown): void {
  f.db.exec('CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, nodes TEXT NOT NULL)')
  f.db.query('INSERT INTO workspace (id, name, nodes) VALUES (?, ?, ?)').run('w-p1', 'Alpha WS', typeof nodes === 'string' ? nodes : JSON.stringify(nodes))
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
    expect(first.items[0]).toEqual({ id: 'n0', kind: 'terminal', title: expect.stringMatching(/truncated\]$/), agentId: null })
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
    expect(await execTool(ctx(), 'node.list', { projectId: 'p2' })).toMatchObject({ ok: false, code: 'workspace_not_found' })
    for (const bad of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 'x' }]) {
      expect(await execTool(ctx(), 'node.list', { projectId: 'p1', ...bad })).toMatchObject({ ok: false, code: 'invalid_shape' })
    }
  })
})
