import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNode } from '../../../canvas/canvasPush'
import type { ChatPort } from '../../../agentChat/agentChat.port'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import type { WorkStore } from '../../work/workModel'
import { createWorkStore } from '../../work/workStore'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'
import { createTaskWorkDefs } from './task.work.defs'

// test-only board of project p1 (workspace w-p1, seeded by seedPortfolio).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'agentChat', x: 0, y: 0, name: 'Puffin' },
  { id: 'n2', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
  { id: 'n3', kind: 'agent', x: 0, y: 0, name: 'Fern', agentId: 'claude' },
  { id: 'c-ag1', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
  { id: 'n4', kind: 'agent', x: 0, y: 0, name: 'Otter', agentId: 'claude' },
]

let f: Fixture
let store: WorkStore
let unregister = (): void => undefined
let sent: unknown[][]
let failSend: string | null
const chats = {
  async send(ws: string, id: string, text: string) { sent.push(['chat', ws, id, text]); return failSend ? { ok: false, code: failSend } : { ok: true, started: false } },
} as unknown as ChatPort
// Plain-shell submit path (one write); the confirmed Claude path is covered by agentSubmit.test.ts.
const sessions = { isLive: (id: string) => id !== 'n4', input: (id: string, data: string) => { sent.push(['pty', id, data]) }, statusOf: () => undefined, screenSource: () => undefined, agentIdOf: () => undefined }

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); sent = []; failSend = null
  store = createWorkStore(f.db, () => 1)
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD } : null))
  f.db.exec(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES ('ag1', 'p1', 'claude', 'pty', 'working', 'central:global', 1)`)
})
afterEach(() => { unregister(); f.close() })

function ctx(conversationId = 'central:global'): ToolCtx {
  const registry = createRegistry()
  createTaskWorkDefs({ chats: async () => chats, sessions: async () => sessions }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId, turnId: 'turn-1', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}
const run = (tool: string, input: Record<string, unknown>, c = ctx()) => execTool(c, tool, input)
const create = async (over: Record<string, unknown> = {}): Promise<string> => String((await run('task.create', { projectId: 'p1', title: 'Add login', objective: 'Users can sign in', ...over })).data?.taskId)

describe('task.* declarations', () => {
  it('has the planned tiers, short summaries and id-only audit keys', () => {
    const defs = createTaskWorkDefs({ chats: () => chats, sessions: () => sessions })
    expect(defs.map((d) => `${d.name}:${d.tier}`)).toEqual(['task.create:R1', 'task.update:R1', 'task.list:R0', 'task.get:R0', 'task.assign:R2', 'task.cancel:R1'])
    for (const d of defs) {
      expect(d.summary.length, d.name).toBeLessThanOrEqual(120)
      expect(d.auditKeys).not.toContain('instruction')
      expect(d.auditKeys).not.toContain('objective')
    }
  })
})

describe('task.create', () => {
  it('creates a todo card tagged with the conversation and turn', async () => {
    const id = await create({ acceptance: 'project_checks', dueAt: 99, boundaries: ['src/auth'] })
    expect(store.getTask(id)).toMatchObject({ status: 'todo', acceptance: 'project_checks', dueAt: 99, boundaries: ['src/auth'], conversationId: 'central:global', turnId: 'turn-1', createdBy: 'central' })
  })
  it('a task waiting on another starts blocked', async () => {
    const dep = await create()
    expect((await run('task.create', { projectId: 'p1', title: 't', objective: 'o', blockedBy: [dep] })).data).toMatchObject({ status: 'blocked' })
  })
  it('refuses a dependency on an unknown task and leaves nothing behind', async () => {
    expect(await run('task.create', { projectId: 'p1', title: 't', objective: 'o', blockedBy: ['nope'] })).toMatchObject({ ok: false, code: 'task_not_found' })
    expect(store.listTasks({ projectId: 'p1' })).toEqual([])
  })
  it('refuses bad shapes', async () => {
    for (const bad of [{ title: '' }, { title: ' ' }, { objective: undefined }, { acceptance: 'nope' }, { dueAt: -1 }, { boundaries: [1] }, { extra: 1 }]) {
      expect((await run('task.create', { projectId: 'p1', title: 't', objective: 'o', ...bad })).code).toBe('invalid_shape')
    }
    expect((await run('task.create', { projectId: 'p1', title: 't', objective: 'o', status: 'done' })).code).toBe('forbidden_key')
  })
})

describe('task.update', () => {
  it('changes the named fields only', async () => {
    const id = await create()
    expect((await run('task.update', { taskId: id, fields: { title: 'New', dueAt: null } })).ok).toBe(true)
    expect(store.getTask(id)).toMatchObject({ title: 'New', objective: 'Users can sign in', dueAt: null })
  })
  it('cannot touch the status', async () => {
    const id = await create()
    expect((await run('task.update', { taskId: id, fields: { status: 'done' } })).code).toBe('forbidden_key')
    expect(store.getTask(id)?.status).toBe('todo')
  })
  it('refuses empty, unknown and out-of-scope updates', async () => {
    const id = await create()
    expect((await run('task.update', { taskId: id, fields: {} })).code).toBe('invalid_shape')
    expect((await run('task.update', { taskId: id, fields: { owner: 'x' } })).code).toBe('invalid_shape')
    expect((await run('task.update', { taskId: 'nope', fields: { title: 'x' } })).code).toBe('task_not_found')
    expect((await run('task.update', { taskId: id, fields: { title: 'x' } }, ctx('central:project:p2'))).code).toBe('task_not_found')
  })
})

describe('task.list', () => {
  it('filters by project and status, and pages', async () => {
    const a = await create()
    await create({ title: 'Second' })
    await run('task.cancel', { taskId: a, reason: 'dropped' })
    expect((await run('task.list', { projectId: 'p1' })).data).toMatchObject({ count: 2 })
    expect((await run('task.list', { projectId: 'p1', status: 'cancelled' })).data?.tasks).toMatchObject([{ id: a, status: 'cancelled' }])
    expect((await run('task.list', { projectId: 'p1', limit: 1, offset: 1 })).data).toMatchObject({ count: 1 })
  })
  it('defaults to the project of a scoped conversation, and refuses another', async () => {
    const id = await create()
    store.createTask({ projectId: 'p2', title: 'other', objective: 'o', actor: { kind: 'central' } })
    expect((await run('task.list', {})).data).toMatchObject({ count: 2 })
    expect((await run('task.list', {}, ctx('central:project:p1'))).data?.tasks).toMatchObject([{ id }])
    expect((await run('task.list', { projectId: 'p2' }, ctx('central:project:p1'))).code).toBe('conversation_project_mismatch')
  })
  it('clips long objectives and refuses bad filters', async () => {
    await create({ objective: 'x'.repeat(2000) })
    const [task] = (await run('task.list', {})).data?.tasks as Array<{ objective: string }>
    expect(task!.objective.length).toBeLessThanOrEqual(300)
    expect((await run('task.list', { status: 'nope' })).code).toBe('invalid_shape')
    expect((await run('task.list', { limit: 0 })).code).toBe('invalid_shape')
    expect((await run('task.list', { projectId: 'missing' })).code).toBe('project_not_found')
    expect((await run('task.list', { actor: 'x' })).code).toBe('forbidden_key')
  })
})

describe('task.get', () => {
  it('returns the card, its attempts and its timeline', async () => {
    const id = await create()
    await run('task.assign', { projectId: 'p1', taskId: id, nodeId: 'n1', instruction: 'build it' })
    const res = await run('task.get', { taskId: id })
    expect(res.data).toMatchObject({ task: { id, status: 'assigned' }, assignments: [{ nodeId: 'n1', instruction: 'build it' }] })
    expect((res.data?.timeline as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['work.task.todo', 'work.assignment.open', 'work.task.assigned'])
  })
  it('keeps only the last 50 events', async () => {
    const id = await create()
    for (let i = 0; i < 60; i++) f.db.query("INSERT INTO event (ts, actor, kind, payload_json, correlation_id) VALUES (?, 'x', ?, '{}', ?)").run(i, `k${i}`, id)
    const timeline = (await run('task.get', { taskId: id })).data?.timeline as Array<{ kind: string }>
    expect(timeline).toHaveLength(50)
    expect(timeline.at(-1)?.kind).toBe('k59')
  })
  it('hides another project from a scoped conversation', async () => {
    const id = await create()
    expect((await run('task.get', { taskId: id }, ctx('central:project:p2'))).code).toBe('task_not_found')
    expect((await run('task.get', { taskId: 'has space' })).code).toBe('invalid_shape')
  })
})

describe('task.assign', () => {
  it('sends to an Agent Chat by name, recording first', async () => {
    const id = await create()
    expect((await run('task.assign', { projectId: 'p1', taskId: id, nodeId: 'puffin', instruction: 'build it' })).data).toMatchObject({ taskId: id, nodeId: 'n1', assignmentId: expect.any(String) })
    expect(sent).toEqual([['chat', 'w-p1', 'n1', 'build it']])
    expect(store.openAssignmentOfNode('n1')).toMatchObject({ channel: 'chat', taskId: id, turnId: 'turn-1' })
  })
  it('types into a Claude terminal', async () => {
    const id = await create()
    await run('task.assign', { projectId: 'p1', taskId: id, nodeId: 'Fern', instruction: 'build it' })
    expect(sent).toEqual([['pty', 'n3', 'build it\r']])
    expect(store.openAssignmentOfNode('n3')).toMatchObject({ channel: 'terminal', taskId: id })
  })
  it('refuses plain terminals, spawned workers, stopped sessions and unknown nodes', async () => {
    const id = await create()
    const assign = (nodeId: string) => run('task.assign', { projectId: 'p1', taskId: id, nodeId, instruction: 'x' })
    expect((await assign('n2')).code).toBe('not_trackable')
    expect((await assign('c-ag1')).code).toBe('use_agent_tool')
    expect((await assign('n4')).code).toBe('session_not_running')
    expect((await assign('nope')).code).toBe('node_not_found')
    expect(sent).toEqual([])
    expect(store.getTask(id)?.status).toBe('todo')
  })
  it('a failed send puts the task back', async () => {
    const id = await create()
    failSend = 'chat_offline'
    expect((await run('task.assign', { projectId: 'p1', taskId: id, nodeId: 'n1', instruction: 'x' })).code).toBe('chat_offline')
    expect(store.getTask(id)?.status).toBe('todo')
  })
  it('refuses a busy node, a missing task and bad shapes', async () => {
    const a = await create()
    const b = await create()
    await run('task.assign', { projectId: 'p1', taskId: a, nodeId: 'n1', instruction: 'x' })
    expect(await run('task.assign', { projectId: 'p1', taskId: b, nodeId: 'n1', instruction: 'y' })).toMatchObject({ ok: false, code: 'node_busy', data: { taskId: a } })
    expect((await run('task.assign', { projectId: 'p1', taskId: 'nope', nodeId: 'n3', instruction: 'y' })).code).toBe('task_not_found')
    expect((await run('task.assign', { projectId: 'p1', taskId: a, nodeId: 'n1', instruction: ' ' })).code).toBe('invalid_shape')
    expect((await run('task.assign', { projectId: 'p1', taskId: a, nodeId: 'n1' })).code).toBe('invalid_shape')
  })
})

describe('task.cancel', () => {
  it('cancels and ends the open assignment', async () => {
    const id = await create()
    await run('task.assign', { projectId: 'p1', taskId: id, nodeId: 'n1', instruction: 'x' })
    const assignmentId = store.openAssignmentOfNode('n1')?.id
    expect((await run('task.cancel', { taskId: id, reason: 'not needed' })).data).toMatchObject({ status: 'cancelled', assignmentId })
    expect(store.getAssignment(assignmentId as string)).toMatchObject({ endReason: 'cancelled', result: { reason: 'not needed' } })
  })
  it('refuses a task already finished, and a blank reason', async () => {
    const id = await create()
    await run('task.cancel', { taskId: id, reason: 'x' })
    expect((await run('task.cancel', { taskId: id, reason: 'again' })).code).toBe('illegal_transition')
    expect((await run('task.cancel', { taskId: id, reason: ' ' })).code).toBe('invalid_shape')
  })
})
