import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasAddInput, CanvasNode } from '../../../canvas/canvasPush'
import type { Workspace } from '../../../../shared/workspace'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx, Tier } from '../toolTypes'
import { createCanvasActDefs, type NodeCanvas } from './canvas.act.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board of project p1 (workspace w-p1, seeded by seedPortfolio).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'shell', cwd: '/srv/alpha' },
  { id: 'n2', kind: 'browser', x: 0, y: 0, url: 'https://example.com/' },
  { id: 'c-ag1', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
  { id: 'c-ag2', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
]

let f: Fixture
let unregister = (): void => undefined
let adds: CanvasAddInput[]
let removes: Array<{ workspaceId: string; nodeIds: string[] }>
const fake: NodeCanvas = {
  add: (input) => { adds.push(input); return { ok: true, updatedAt: 2, nodes: input.nodes } },
  remove: (input) => {
    removes.push(input)
    return { ok: true, workspace: { id: input.workspaceId } as Workspace, removed: BOARD.filter((n) => input.nodeIds.includes(n.id)) }
  },
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); adds = []; removes = []
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD } : null))
  // ag1 is a live worker; ag2 has ended (its node is an ordinary leftover).
  f.db.exec(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES
    ('ag1', 'p1', 'claude', 'pty', 'working', 'central:global', 1), ('ag2', 'p1', 'claude', 'pty', 'closed', 'central:global', 1)`)
})
afterEach(() => { unregister(); f.close() })

function ctx(maxTier: Tier = 'R2', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createCanvasActDefs({ canvas: () => fake, browserOn: () => true }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const close = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.close', { projectId: 'p1', reason: 'tidy up', ...input })
const open = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.open', { projectId: 'p1', ...input })

describe('canvas.open / canvas.close defs', () => {
  it('declares close at R2 (approval card via the guard ladder) and open at R1, both behind the read-tools flag', async () => {
    const defs = createCanvasActDefs({ canvas: () => fake, browserOn: () => true })
    expect(defs.map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.open', 'R1', READ_TOOLS_FLAG], ['canvas.close', 'R2', READ_TOOLS_FLAG]])
    expect(await close({ nodeIds: ['n1'] }, ctx('R1'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await open({ kind: 'terminal' }, ctx('R2', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(await close({ nodeIds: ['n1'] }, ctx('R2', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(removes.length + adds.length).toBe(0)
  })
})

describe('canvas.close', () => {
  it('rejects malformed input before touching the board', async () => {
    const bad = [
      { nodeIds: [] }, { nodeIds: Array.from({ length: 51 }, (_, i) => `n${i}`) }, { nodeIds: ['a b'] }, { nodeIds: 'n1' },
      { nodeIds: ['n1'], reason: '' }, { nodeIds: ['n1'], reason: 'x'.repeat(201) }, { nodeIds: ['n1'], reason: 'bell\x07' },
      { nodeIds: ['n1'], extra: 1 },
    ]
    for (const input of bad) expect(await close(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await execTool(ctx(), 'canvas.close', { projectId: 'p1', nodeIds: ['n1'] })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(removes).toEqual([])
  })

  it('refuses the whole call when any id is not on the board, naming the unknown ones', async () => {
    const res = await close({ nodeIds: ['n1', 'ghost', 'n2', 'gone'] })
    expect(res).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['ghost', 'gone'] } })
    expect(removes).toEqual([])
  })

  it('sends live Central workers to agent.close but lets ended ones close', async () => {
    const res = await close({ nodeIds: ['n1', 'c-ag1'] })
    expect(res).toMatchObject({ ok: false, code: 'use_agent_close', data: { nodeIds: ['c-ag1'], hint: expect.stringContaining('agent.close') } })
    expect(removes).toEqual([])
    expect(await close({ nodeIds: ['c-ag2'] })).toMatchObject({ ok: true, data: { count: 1 } })
  })

  it('removes the de-duplicated ids from the project workspace and reports id/kind/title', async () => {
    const res = await close({ nodeIds: ['n1', 'n2', 'n1'] })
    expect(removes).toEqual([{ workspaceId: 'w-p1', nodeIds: ['n1', 'n2'] }])
    expect(res).toMatchObject({ ok: true, data: { count: 2, ids: ['n1', 'n2'], closed: [{ id: 'n1', kind: 'terminal', title: 'shell' }, { id: 'n2', kind: 'browser', title: null }] } })
    expect(JSON.stringify(res)).not.toContain('/srv/alpha')
  })

  it('passes a board write failure through as its code', async () => {
    const c = ctx()
    c.registry = createRegistry()
    createCanvasActDefs({ canvas: () => ({ ...fake, remove: () => ({ ok: false, code: 'node_not_found' }) }), browserOn: () => true }).forEach((d) => c.registry.register(d))
    expect(await close({ nodeIds: ['n1'] }, c)).toMatchObject({ ok: false, code: 'node_not_found' })
  })
})

describe('canvas.open', () => {
  it('rejects malformed input, model-supplied cwd/cmd and non-http urls', async () => {
    const bad = [
      { kind: 'shell' }, { kind: 'terminal', count: 0 }, { kind: 'terminal', count: 6 }, { kind: 'claude', count: 1.5 },
      { kind: 'browser', count: 2 }, { kind: 'terminal', url: 'https://example.com' }, { kind: 'browser', url: 'javascript:alert(1)' },
      { kind: 'browser', url: 'file:///etc/passwd' }, { kind: 'browser', url: 'https://u:p@example.com' }, { kind: 'browser', url: 'example.com' },
      { kind: 'terminal', title: 't'.repeat(81) }, { kind: 'terminal', title: 'a\x1bb' }, { kind: 'terminal', extra: true },
    ]
    for (const input of bad) expect(await open(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await open({ kind: 'terminal', cwd: '/etc' })).toMatchObject({ ok: false, code: 'forbidden_key' })
    expect(await open({ kind: 'claude', cmd: 'rm -rf /' })).toMatchObject({ ok: false, code: 'forbidden_key' })
    expect(adds).toEqual([])
  })

  it('opens N terminals in the project directory with no anchor', async () => {
    const res = await open({ kind: 'terminal', count: 3, title: 'build' })
    expect(adds).toHaveLength(1)
    const [call] = adds
    expect(call!.workspaceId).toBe('w-p1')
    expect(call!.anchorNodeId).toBeUndefined()
    expect(call!.nodes.map((n) => [n.kind, n.cwd, n.title])).toEqual(Array(3).fill(['terminal', '/srv/alpha', 'build']))
    expect(new Set(call!.nodes.map((n) => n.id)).size).toBe(3)
    expect(res).toMatchObject({ ok: true, data: { count: 3, kind: 'terminal', opened: call!.nodes.map((n) => ({ id: n.id, kind: 'terminal' })) } })
  })

  it('opens a builtin claude node with a recorded launch profile and no pre-minted session', async () => {
    await open({ kind: 'claude' })
    const node = adds[0]!.nodes[0]!
    expect(node).toMatchObject({ kind: 'agent', agentId: 'claude', cwd: '/srv/alpha', cmd: expect.stringContaining('claude'), claudeProfileId: expect.any(String) })
    expect(node.sessionId).toBeUndefined()
  })

  it('opens a browser at the normalized url (page start applies the nav guard) or blank', async () => {
    await open({ kind: 'browser', url: '  https://GitHub.com/org  ' })
    await open({ kind: 'browser' })
    expect(adds.map((a) => a.nodes[0])).toEqual([
      { id: expect.any(String), kind: 'browser', x: 0, y: 0, width: 640, height: 400, url: 'https://github.com/org' },
      { id: expect.any(String), kind: 'browser', x: 0, y: 0, width: 640, height: 400 },
    ])
  })

  it('refuses a browser while the browser feature is off in Settings, but still opens terminals', async () => {
    const c = ctx()
    c.registry = createRegistry()
    createCanvasActDefs({ canvas: () => fake, browserOn: () => false }).forEach((d) => c.registry.register(d))
    expect(await open({ kind: 'browser', url: 'https://example.com' }, c)).toMatchObject({ ok: false, code: 'browser_disabled', data: { hint: expect.stringContaining('Settings') } })
    expect(adds).toEqual([])
    expect(await open({ kind: 'terminal' }, c)).toMatchObject({ ok: true, data: { count: 1, kind: 'terminal' } })
    expect(adds).toHaveLength(1)
  })

  it('reports a project without a workspace and never calls add', async () => {
    expect(await execTool(ctx(), 'canvas.open', { projectId: 'p2', kind: 'terminal' })).toMatchObject({ ok: false, code: 'workspace_not_found' })
    expect(adds).toEqual([])
  })
})
