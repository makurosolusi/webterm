import { describe, expect, it } from 'vitest'
import type { CanvasAddInput, CanvasPush } from '../../canvas/canvasPush'
import { logBus } from '../../logs'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeAllocation, WorktreeService } from '../../orchestrator/worktree'
import { createAgentSpawner } from '../../spawn/agentSpawn'
import type { Workspace } from '../../../shared/workspace'
import type { ControlGuard } from '../contracts'
import { openFixture, seedPortfolio } from '../centralTestFixture.testutil'
import { AGENT_ENVELOPE, agentNodeId, createAgentExecutor, type SpawnInput } from './agentExecutor'
import { agentSessionId } from './agentCanvas'
import type { AgentCatalog, CatalogEntry } from './agentCatalog'
import { createAgentHost } from './agentHost'
import { agentReqId } from './agentStore'

const T0 = 1_700_000_000_000
const REPO = '/repo/p1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// test-only fakes: a builtin claude PTY kind, a headless kind, sessions/worktrees/board in memory.
const entries: Record<string, CatalogEntry> = {
  claude: { kind: 'claude', builtin: true, tier: 'R2', launchLine: 'claude', headlessArgv: null, childEnv: () => ({}) } as unknown as CatalogEntry,
  hx: { kind: 'hx', builtin: false, tier: 'R2', launchLine: 'hx', headlessArgv: (p: string) => ['hx', p], childEnv: () => ({}) } as unknown as CatalogEntry,
}
const catalog: AgentCatalog = { resolve: (k) => entries[k] ?? null, kinds: () => [] }
const guard: ControlGuard = {
  check: () => ({ verdict: 'allow', level: 'act_gated' }), effectiveLevel: () => 'act_gated', recordUsage: () => undefined,
  breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
}

function fakeCanvas(boards: Record<string, string> = { [REPO]: 'w1' }, refuse = false) {
  const adds: CanvasAddInput[] = []
  const placed = new Map<string, string>()
  const ws = (id: string) => ({ id } as Workspace)
  const canvas: CanvasPush = {
    add(input) {
      adds.push(input)
      if (refuse) return { ok: false, code: 'node_exists' }
      for (const n of input.nodes) placed.set(n.id, input.workspaceId)
      return { ok: true, updatedAt: T0, nodes: input.nodes }
    },
    remove: () => ({ ok: false, code: 'workspace_not_found' }), // not exercised by spawn placement
    update: () => ({ ok: false, code: 'workspace_not_found' }), // not exercised by spawn placement
    groups: () => ({ ok: false, code: 'workspace_not_found' }), // not exercised by spawn placement
    workspaceOfNode: (id) => (placed.has(id) ? ws(placed.get(id) as string) : null),
    workspaceForCwd: (cwd) => (boards[cwd] ? ws(boards[cwd] as string) : null),
  }
  return { canvas, adds, placed }
}

function setup(canvasFake = fakeCanvas()) {
  const f = openFixture(); seedPortfolio(f.db)
  const opens: Parameters<WorkerSessionPort['open']>[0][] = []
  const live = new Set<string>()
  const sessions = {
    open: (i: Parameters<WorkerSessionPort['open']>[0]) => { opens.push(i); live.add(i.nodeId) },
    isLive: (id: string) => live.has(id), input: () => {}, submit: async () => ({ ok: true as const, started: true as const }), close: () => {}, getTerminal: () => '', statusOf: () => undefined,
  } as WorkerSessionPort
  const wts = new Map<string, WorktreeAllocation>()
  const worktrees = {
    get: (id: string) => wts.get(id),
    allocate: async (i: { taskId: string }) => { const a = { taskId: i.taskId, path: `/wt/${i.taskId}` } as WorktreeAllocation; wts.set(i.taskId, a); return a },
  } as unknown as WorktreeService
  const spawner = createAgentSpawner({ ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {} })
  const host = createAgentHost({ sessions, worktrees, repoOf: () => REPO, catalog, spawn: spawner.spawn, canvas: canvasFake.canvas })
  const headless = async () => ({ ok: true as const, childId: 'central' as const, nodeId: 'x', depth: 1, name: 'hx', handle: { pid: 1, done: new Promise<never>(() => {}), tail: () => '', kill: () => {} } })
  const ex = createAgentExecutor({ db: f.db, guard, host, now: () => T0, spawn: headless as never })
  const input = (over: Partial<SpawnInput> = {}): SpawnInput => ({ projectId: 'p1', kind: 'claude', role: 'worker', title: 't', reqId: agentReqId('p1', 'r1'), owner: 'central:c1', requireApproval: false, ...over })
  return { ex, input, opens, live, ...canvasFake }
}

describe('Central pty agent on the canvas', () => {
  it('adds one agent node, shaped like a canvas Claude node, to the board of the project repo', async () => {
    const { ex, input, adds, opens } = setup()
    const res = await ex.spawn(input())
    expect(res.data).toMatchObject({ state: 'working' })
    const id = String(res.data?.agentId)
    const sid = agentSessionId({ id, kind: 'claude' })
    expect(sid).toMatch(UUID)
    expect(adds).toEqual([{ workspaceId: 'w1', nodes: [{ id: agentNodeId(id), kind: 'agent', x: 0, y: 0, cmd: 'claude', agentId: 'claude', cwd: `/wt/${id}`, title: 'worker claude', color: expect.any(String), sessionId: sid }] }])
    // Same identity as a canvas node: agentId + session id (hooks/--settings) on the PTY open; the task rides as the positional prompt.
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({ nodeId: agentNodeId(id), cwd: `/wt/${id}`, agentId: 'claude', sessionId: sid })
    expect(opens[0]?.cmd).toBe(`claude '${AGENT_ENVELOPE} Role: worker. No task attached. Work only inside this worktree; do not merge or push.'`)
  })

  it('no board for the repo: the spawn still works and a warn names the agent only', async () => {
    const { ex, input, adds } = setup(fakeCanvas({}))
    const before = logBus.query().length
    const res = await ex.spawn(input())
    expect(res.data).toMatchObject({ state: 'working' })
    expect(adds).toEqual([])
    const warn = logBus.query().slice(before).find((e) => e.event === 'agent.canvas.no_board')
    expect(warn).toMatchObject({ level: 'warn' })
    expect(JSON.stringify(warn)).not.toContain('/wt/')
  })

  it('a refused add never fails the spawn', async () => {
    const { ex, input, adds } = setup(fakeCanvas({ [REPO]: 'w1' }, true))
    expect((await ex.spawn(input())).data).toMatchObject({ state: 'working' })
    expect(adds).toHaveLength(1)
  })

  it('a headless (exec) agent adds no node', async () => {
    const { ex, input, adds } = setup()
    expect((await ex.spawn(input({ kind: 'hx' }))).data).toMatchObject({ state: 'working', runner: 'exec' })
    expect(adds).toEqual([])
  })

  it('boot sweep re-adds a live agent missing from every board once, never twice', async () => {
    const { ex, input, adds, placed } = setup()
    const id = String((await ex.spawn(input())).data?.agentId)
    placed.clear()
    await ex.reconcile()
    await ex.reconcile()
    expect(adds.map((a) => a.nodes.map((n) => n.id))).toEqual([[agentNodeId(id)], [agentNodeId(id)]])
    expect(adds[1]?.nodes[0]?.sessionId).toBe(agentSessionId({ id, kind: 'claude' }))
  })
})

describe('agentSessionId', () => {
  it('is a deterministic UUID per agent, absent for kinds that take no session id', () => {
    expect(agentSessionId({ id: 'a1', kind: 'claude' })).toBe(agentSessionId({ id: 'a1', kind: 'claude' }))
    expect(agentSessionId({ id: 'a1', kind: 'claude' })).not.toBe(agentSessionId({ id: 'a2', kind: 'claude' }))
    expect(agentSessionId({ id: 'a1', kind: 'opencode' })).toBeUndefined()
  })
})
