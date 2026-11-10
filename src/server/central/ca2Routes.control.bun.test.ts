import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { type BoardDeps } from './ca2Routes.nodes'
import { ca2Dispatch, isCa2Path } from './ca2Routes'
import { addAgent, freshDb, run, T0 } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'
import { registerWorkspaceLookup, type WorkspaceRecord } from './workspaceLookup'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
let dir: string
let h: Ca2Handle
let unregister: () => void = () => {}

function boot(agents = 'propose'): Ca2Handle {
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({
    runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0,
    env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: agents, WEBTERM_CENTRAL_MODEL: 'paid' },
  })
  if (!booted) throw new Error('boot failed')
  return booted
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ca2-control-')); h = boot() })
afterEach(() => { unregister(); unregister = () => {}; h.stop(); setActiveCa2(null); rmSync(dir, { recursive: true, force: true }) })

const board: BoardDeps = {
  sessions: () => ({ isLive: (id) => id === 'pty-live', statusOf: (id) => (id === 'pty-live' ? 'working' : undefined), getTerminal: () => '', getTranscript: () => undefined }),
  chats: () => ({ snapshot: () => ({ live: true, status: 'thinking', model: null, config: { model: null, effort: null, thinking: true }, permissionMode: 'manual', costUsd: 0, contextPct: 0, pending: null }) }) as never,
}
const get = (path: string) => ca2Dispatch(h, { method: 'GET', path: path.split('?')[0] ?? path, query: new URL(path, 'http://x').searchParams, body: async () => ({}) }, undefined, board)
const items = async (path: string) => ((await get(path))?.body as { items: Array<Record<string, unknown>> }).items
const stored = (workspaces: WorkspaceRecord[]): void => { unregister = registerWorkspaceLookup((id) => workspaces.find((w) => w.id === id) ?? null, () => workspaces) }
const insertTurn = (id: string, status: string, startedAt: number, endedAt: number | null): void =>
  run(h.db, 'INSERT INTO central_turn (id, conversation_id, message_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)', id, 'c', 'm', status, startedAt, endedAt)

describe('status lastTurn', () => {
  const lastTurn = async () => ((await get('/api/central/status'))?.body as { lastTurn: unknown }).lastTurn
  it('is null before any turn', async () => { expect(await lastTurn()).toBeNull() })
  it('reports when the newest turn ended', async () => {
    insertTurn('t1', 'succeeded', 10, 20)
    insertTurn('t2', 'failed', 30, 40)
    expect(await lastTurn()).toEqual({ at: 40, status: 'failed' })
  })
  it('prefers a turn still running over a newer finished one', async () => {
    insertTurn('t1', 'running', 10, null)
    insertTurn('t2', 'succeeded', 30, 40)
    expect(await lastTurn()).toEqual({ at: 10, status: 'running' })
  })
})

describe('agents filters', () => {
  beforeEach(() => {
    addAgent(h.db, 'a-live', 'p1', 'working')
    addAgent(h.db, 'a-done', 'p1', 'closed')
    addAgent(h.db, 'a-other', 'p2', 'working')
  })
  const ids = async (query: string) => (await items(`/api/central/agents${query}`)).map((r) => r.id).sort()

  it('live=1 drops terminal rows; no flag keeps them', async () => {
    expect(await ids('?live=1')).toEqual(['a-live', 'a-other'])
    expect(await ids('')).toEqual(['a-done', 'a-live', 'a-other'])
  })
  it('projectId narrows, combined with live', async () => {
    expect(await ids('?projectId=p1')).toEqual(['a-done', 'a-live'])
    expect(await ids('?projectId=p1&live=1')).toEqual(['a-live'])
  })
  it('keeps pagination inside the filter', async () => {
    expect((await items('/api/central/agents?live=1&limit=1&offset=0')).length).toBe(1)
    expect((await items('/api/central/agents?live=1&limit=1&offset=2')).length).toBe(0)
    expect((await get('/api/central/agents?limit=0'))?.status).toBe(400)
  })
  it('joins the project name and reports the node and start time', async () => {
    run(h.db, "UPDATE central_agents SET node_id = 'n7' WHERE id = 'a-live'")
    stored([{ id: 'w1', name: 'One', nodes: [{ id: 'n7', kind: 'agent', agentId: 'claude' }] }])
    const row = (await items('/api/central/agents?projectId=p1&live=1'))[0]
    expect(row).toMatchObject({ id: 'a-live', nodeId: 'n7', nodeOnBoard: true, startedAt: 1, projectName: 'One' })
  })
  it('marks a node that no longer exists, and finds a c-<id> node without node_id', async () => {
    run(h.db, "UPDATE central_agents SET node_id = 'gone' WHERE id = 'a-live'")
    stored([{ id: 'w2', name: 'Two', nodes: [{ id: 'c-a-other', kind: 'agent', agentId: 'claude' }] }])
    expect((await items('/api/central/agents?projectId=p1&live=1'))[0]).toMatchObject({ nodeId: 'gone', nodeOnBoard: false })
    expect((await items('/api/central/agents?projectId=p2'))[0]).toMatchObject({ nodeId: 'c-a-other', nodeOnBoard: true })
  })
})

describe('board nodes', () => {
  const boards: WorkspaceRecord[] = [
    { id: 'w1', name: 'One', nodes: [
      { id: 'chat1', kind: 'agentChat', title: 'Fix login' },
      { id: 'pty-live', kind: 'agent', agentId: 'claude', name: 'Mango' },
      { id: 'sh', kind: 'terminal' },
      { id: 'other-cli', kind: 'agent', agentId: 'codex' },
      { id: 'worker-node', kind: 'agent', agentId: 'claude' },
      { id: 'c-a-spawned', kind: 'agent', agentId: 'claude' },
    ] },
    { id: 'w2', name: 'Two', nodes: [{ id: 'chat2', kind: 'agentChat' }] },
  ]
  const spawned = (): void => {
    addAgent(h.db, 'a-worker', 'p1', 'closed')
    run(h.db, "UPDATE central_agents SET node_id = 'worker-node' WHERE id = 'a-worker'")
    addAgent(h.db, 'a-spawned', 'p1', 'working')
  }

  it('is a panel path and only answers GET', async () => {
    expect(isCa2Path('/api/central/nodes')).toBe(true)
    expect((await ca2Dispatch(h, { method: 'POST', path: '/api/central/nodes', query: new URLSearchParams(), body: async () => ({}) }))?.status).toBe(405)
  })

  it('lists Claude nodes that Central did not start, across boards, with live status', async () => {
    stored(boards)
    spawned()
    const rows = await items('/api/central/nodes')
    expect(rows.map((r) => r.nodeId)).toEqual(['chat1', 'pty-live', 'chat2'])
    expect(rows[0]).toEqual({ nodeId: 'chat1', workspaceId: 'w1', projectId: 'p1', projectName: 'One', kind: 'agentChat', title: 'Fix login', live: true, status: 'thinking' })
    expect(rows[1]).toMatchObject({ title: 'Mango', live: true, status: 'working' })
  })

  it('reports a dead Claude terminal as not live', async () => {
    stored([{ id: 'w1', name: 'One', nodes: [{ id: 'dead', kind: 'agent', agentId: 'claude' }] }])
    expect((await items('/api/central/nodes'))[0]).toMatchObject({ nodeId: 'dead', live: false, status: null })
  })

  it('paginates and rejects a bad page', async () => {
    stored(boards)
    spawned()
    expect((await items('/api/central/nodes?limit=2&offset=0')).map((r) => r.nodeId)).toEqual(['chat1', 'pty-live'])
    expect((await items('/api/central/nodes?limit=2&offset=2')).map((r) => r.nodeId)).toEqual(['chat2'])
    expect((await get('/api/central/nodes?offset=-1'))?.status).toBe(400)
  })

  it('narrows by project and always lists every project for the filter', async () => {
    stored(boards)
    const res = (await get('/api/central/nodes?projectId=p2'))?.body as { items: Array<{ nodeId: string }>; projects: unknown }
    expect(res.items.map((r) => r.nodeId)).toEqual(['chat2'])
    expect(res.projects).toEqual([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }])
  })

  it('works with agents off', async () => {
    h.stop()
    setActiveCa2(null)
    h = boot('off')
    expect(h.executor).toBeNull()
    expect((await get('/api/central/agents'))?.status).toBe(503)
    stored([{ id: 'w1', name: 'One', nodes: [{ id: 'chat1', kind: 'agentChat' }] }])
    const res = await get('/api/central/nodes')
    expect(res?.status).toBe(200)
    expect((res?.body as { items: unknown[] }).items).toHaveLength(1)
  })

  it('answers workspaces_off when no store is registered', async () => {
    const res = await get('/api/central/nodes')
    expect(res?.status).toBe(503)
    expect(res?.body).toEqual({ error: 'workspaces_off' })
  })
})
