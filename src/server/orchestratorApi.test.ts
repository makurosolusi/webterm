import { describe, expect, it } from 'vitest'
import { orchestratorRoute, type RouteResult } from './orchestratorApi'
import { nodeSqlite } from './nodeSqlite.testutil'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

const NOW = Date.now()

const AGENT_DDL = `
CREATE TABLE agent (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_agent_id TEXT, name TEXT,
  role TEXT NOT NULL, depth INTEGER NOT NULL, capabilities_json TEXT, session_ref TEXT,
  state TEXT NOT NULL DEFAULT 'idle', heartbeat_at INTEGER, created_at INTEGER NOT NULL
);`

const TASKS = [
  { id: 't1', projectId: 'p1', status: 'blocked' },
  { id: 't2', projectId: 'p1', status: 'leased' },
  { id: 't3', projectId: 'p2', status: 'blocked' },
]

function fixture(): LedgerRuntime {
  const { db, raw } = nodeSqlite()
  raw.exec(AGENT_DDL)
  raw.exec(`
    INSERT INTO agent (id, project_id, parent_agent_id, name, role, depth, capabilities_json,
      session_ref, state, heartbeat_at, created_at)
      VALUES ('ag1', 'p1', NULL, 'lead', 'orchestrator', 0, NULL, NULL, 'running', NULL, ${NOW - 20}),
             ('ag2', 'p1', 'ag1', 'builder', 'worker', 1, NULL, NULL, 'idle', NULL, ${NOW - 10}),
             ('ag3', 'p2', NULL, 'other', 'worker', 0, NULL, NULL, 'idle', NULL, ${NOW});
  `)
  const task = {
    listTasks: (projectId: string, status?: string) =>
      TASKS.filter((row) => row.projectId === projectId && (status === undefined || row.status === status)),
  }
  return { db, mode: 'on', path: ':memory:', ledger: { task } } as unknown as LedgerRuntime
}

const call = (path: string, query = '', method = 'GET', runtime: LedgerRuntime | null = fixture()) =>
  orchestratorRoute(path, method, new URLSearchParams(query), runtime)
const ok = (result: RouteResult | null): NonNullable<RouteResult> =>
  result as NonNullable<RouteResult>

interface AgentsBody { projectId: string; agents: { id: string; role: string }[] }
interface TasksBody { projectId: string; status: string | null; tasks: { id: string }[] }

describe('orchestrator read routes', () => {
  it('lists agents of one project', () => {
    const body = ok(call('/api/orchestrator/agents', 'projectId=p1')).body as AgentsBody
    expect(body.projectId).toBe('p1')
    expect(body.agents.map((agent) => agent.id)).toEqual(['ag1', 'ag2'])
    expect(body.agents[1].role).toBe('worker')
  })

  it('lists tasks, optionally filtered by a valid status', () => {
    const all = ok(call('/api/orchestrator/tasks', 'projectId=p1')).body as TasksBody
    expect(all.tasks.map((task) => task.id)).toEqual(['t1', 't2'])
    expect(all.status).toBe(null)

    const blocked = ok(call('/api/orchestrator/tasks', 'projectId=p1&status=blocked')).body as TasksBody
    expect(blocked.tasks.map((task) => task.id)).toEqual(['t1'])
    expect(blocked.status).toBe('blocked')

    expect(ok(call('/api/orchestrator/tasks', 'projectId=p1&status=nope')).status).toBe(400)
  })

  it('answers 503 plan_unavailable on a ledger without the v2 plan table', () => {
    expect(call('/api/orchestrator/plan', 'projectId=p1')).toEqual({
      status: 503,
      body: { error: 'plan_unavailable' },
    })
  })

  it('rejects a missing project and answers 503 when the ledger is off', () => {
    expect(ok(call('/api/orchestrator/plan', '')).status).toBe(400)
    expect(call('/api/orchestrator/agents', '', 'GET', null)).toEqual({
      status: 503,
      body: { error: 'ledger_off' },
    })
    expect(call('/api/orchestrator/spawn', 'projectId=p1')).toBe(null)
    expect(call('/api/orchestrator/agents', 'projectId=p1', 'POST')).toBe(null)
  })
})
