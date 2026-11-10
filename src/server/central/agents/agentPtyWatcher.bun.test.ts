// Bun-only. Fake bus events drive the PTY watcher over a real ledger schema; no real Claude and no real PTY.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventBus, eventBus } from '../../events/eventBus'
import type { EventTrust, SenseEvent } from '../../events/eventModel'
import { reconcile } from '../../featureCapabilities.runtime'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import type { SessionsLike } from '../../orchestrator/workerRuntimeSession'
import { bootCa2, setActiveCa2 } from '../ca2Boot'
import { AGENT_TRANSITIONS, type AgentState, type ControlGuard } from '../contracts'
import { eventKinds, freshDb, T0 } from '../guard/controlGuard.testutil'
import { createRegistry } from '../tools/toolRegistry'
import { type AgentHost, createAgentExecutor } from './agentExecutor'
import { startAgentPtyWatcher } from './agentPtyWatcher'
import { canTransition } from './agentStateMachine'
import { type AgentStore, createAgentStore } from './agentStore'

const now = () => T0
const NODE = 'node-1'
const PATHS: Partial<Record<AgentState, AgentState[]>> = {
  requested: [],
  provisioning: ['provisioning'],
  starting: ['provisioning', 'starting'],
  working: ['provisioning', 'starting', 'working'],
  waiting_input: ['provisioning', 'starting', 'working', 'waiting_input'],
  candidate_done: ['provisioning', 'starting', 'working', 'candidate_done'],
  verifying: ['provisioning', 'starting', 'working', 'candidate_done', 'verifying'],
  accepted: ['provisioning', 'starting', 'working', 'candidate_done', 'verifying', 'accepted'],
  rejected: ['provisioning', 'starting', 'working', 'candidate_done', 'verifying', 'rejected'],
  closing: ['provisioning', 'starting', 'working', 'candidate_done', 'verifying', 'accepted', 'closing'],
}

let seq = 0
function event(kind: string, payload: unknown = {}, nodeId: string | null = NODE, trust: EventTrust = 'trusted'): SenseEvent {
  seq += 1
  return { seq, ts: T0, kind, source: 'test', actor: 'agent', subject: null, workspaceId: null, nodeId, trust, dedupeKey: null, payload, prevHash: '', hash: '' }
}

function addRow(store: AgentStore, state: AgentState, opts: { id?: string; runner?: 'pty' | 'exec'; nodeId?: string | null } = {}) {
  const id = opts.id ?? 'ag1'
  const nodeId = opts.nodeId === undefined ? NODE : opts.nodeId
  store.create({ id, projectId: 'p1', kind: 'claude', role: 'worker', runner: opts.runner ?? 'pty', owner: 'human', reqId: `req-${id}` })
  for (const to of PATHS[state] ?? []) store.transition(id, to, to === 'working' && nodeId ? { nodeId } : {})
  return id
}

function setup() {
  const db = freshDb()
  const store = createAgentStore(db, now)
  const bus = createEventBus()
  const off = startAgentPtyWatcher({ db, store, now, bus })
  return { db, store, bus, off }
}

const phases = (s: ReturnType<typeof setup>) => eventKinds(s.db, 'central.agent').map((p) => p['phase'])

const MAPPING: [string, unknown, AgentState, AgentState, string | null][] = [
  ['hook.Stop', {}, 'working', 'candidate_done', null],
  ['hook.StopFailure', {}, 'working', 'waiting_input', 'stop_failure'],
  ['hook.Notification', { notificationType: 'agent_needs_input' }, 'working', 'waiting_input', null],
  ['hook.Notification', { notificationType: 'elicitation_dialog' }, 'working', 'waiting_input', null],
  ['hook.Notification', { notificationType: 'permission_prompt' }, 'working', 'waiting_input', null],
  ['hook.PermissionRequest', {}, 'working', 'waiting_input', null],
  ['hook.UserPromptSubmit', {}, 'waiting_input', 'working', null],
  ['hook.UserPromptSubmit', {}, 'candidate_done', 'working', null],
  ['hook.PreToolUse', {}, 'waiting_input', 'working', null],
  ['hook.PreToolUse', {}, 'candidate_done', 'working', null],
  ['hook.PostToolUse', {}, 'waiting_input', 'working', null],
  ['hook.PostToolUse', {}, 'candidate_done', 'working', null],
  ['hook.SessionEnd', {}, 'working', 'session_exited', 'session_end'],
  ['hook.SessionEnd', {}, 'waiting_input', 'session_exited', 'session_end'],
  ['pty.exit', {}, 'working', 'session_exited', 'pty_exit'],
  ['pty.exit', {}, 'candidate_done', 'session_exited', 'pty_exit'],
  ['pty.exit', {}, 'verifying', 'session_exited', 'pty_exit'],
]

for (const [kind, payload, from, to, reason] of MAPPING) {
  test(`${kind} ${JSON.stringify(payload)}: ${from} -> ${to}`, () => {
    const s = setup()
    const id = addRow(s.store, from)
    s.bus.publish(event(kind, payload))
    expect(s.store.get(id)).toMatchObject({ state: to, endReason: reason })
    expect(phases(s)).toEqual([`pty.${to}`])
  })
}

const NO_MOVE: [string, unknown, AgentState][] = [
  ['hook.Stop', {}, 'waiting_input'],
  ['hook.Stop', {}, 'candidate_done'],
  ['hook.Notification', { notificationType: 'idle_prompt' }, 'working'],
  ['hook.Notification', {}, 'working'],
  ['hook.SessionStart', {}, 'working'],
  ['hook.UserPromptSubmit', {}, 'working'],
  ['hook.PreToolUse', { subagent: true }, 'candidate_done'],
  ['hook.PostToolUse', { subagent: true }, 'waiting_input'],
  ['pty.exit', {}, 'closing'],
  ['pty.exit', {}, 'accepted'],
  ['hook.SessionEnd', {}, 'closing'],
]

for (const [kind, payload, from] of NO_MOVE) {
  test(`${kind} ${JSON.stringify(payload)} leaves ${from} alone without error or audit`, () => {
    const s = setup()
    const id = addRow(s.store, from)
    s.bus.publish(event(kind, payload))
    expect(s.store.get(id)?.state).toBe(from)
    expect(phases(s)).toEqual([])
    expect(s.bus.subscriberCount).toBe(2)
  })
}

test('an untrusted event never moves a row', () => {
  const s = setup()
  const id = addRow(s.store, 'working')
  s.bus.publish(event('hook.Stop', {}, NODE, 'untrusted'))
  expect(s.store.get(id)?.state).toBe('working')
})

test('a subagent permission request still parks the parent, as hookStatus does', () => {
  const s = setup()
  const id = addRow(s.store, 'working')
  s.bus.publish(event('hook.PermissionRequest', { subagent: true }))
  expect(s.store.get(id)?.state).toBe('waiting_input')
})

test('matches by the deterministic c-<id> node when node_id is unset', () => {
  const s = setup()
  const id = addRow(s.store, 'working', { nodeId: null })
  s.bus.publish(event('hook.Stop', {}, `c-${id}`))
  expect(s.store.get(id)?.state).toBe('candidate_done')
})

test('exec rows and other nodes are ignored', () => {
  const s = setup()
  const exec = addRow(s.store, 'working', { id: 'ag-exec', runner: 'exec' })
  const other = addRow(s.store, 'working', { id: 'ag-other', nodeId: 'node-2' })
  s.bus.publish(event('hook.Stop'))
  s.bus.publish(event('hook.Stop', {}, 'c-ag-exec'))
  s.bus.publish(event('hook.Stop', {}, null))
  expect(s.store.get(exec)?.state).toBe('working')
  expect(s.store.get(other)?.state).toBe('working')
})

test('a failing store does not cost the bus subscription', () => {
  const db = freshDb()
  const store = createAgentStore(db, now)
  const bus = createEventBus()
  const id = addRow(store, 'working')
  startAgentPtyWatcher({ db, store: { ...store, transition: () => { throw new Error('disk full') } }, now, bus })
  bus.publish(event('hook.Stop'))
  expect(bus.subscriberCount).toBe(2)
  expect(store.get(id)?.state).toBe('working')
})

test('unsubscribe stops the moves', () => {
  const s = setup()
  const id = addRow(s.store, 'working')
  s.off()
  expect(s.bus.subscriberCount).toBe(0)
  s.bus.publish(event('hook.Stop'))
  expect(s.store.get(id)?.state).toBe('working')
})

function withExecutor() {
  const s = setup()
  const sent: string[] = []
  const closes: string[] = []
  const host = {
    hasSession: () => true, send: async (_n: string, t: string) => { sent.push(t) },
    // Mirrors sessionsEnd.close: the exit event is published before close returns.
    closePty: async (n: string) => { closes.push(n); s.bus.publish(event('pty.exit', { reason: 'closed' }, n)) },
  } as unknown as AgentHost
  return { ...s, ex: createAgentExecutor({ db: s.db, guard: {} as ControlGuard, host, now }), sent, closes }
}

for (const from of ['waiting_input', 'candidate_done', 'working'] as const) {
  test(`agent.close from ${from} keeps its reason even though the PTY exit event lands during close`, async () => {
    const s = withExecutor()
    const id = addRow(s.store, from)
    const res = await s.ex.close(s.store.get(id)!, 'done with it', false)
    expect(res).toMatchObject({ ok: true, data: { state: 'cancelled', endReason: 'done with it' } })
    expect(s.closes).toEqual([NODE])
  })
}

for (const from of ['waiting_input', 'candidate_done'] as const) {
  test(`agent.prompt from ${from} goes back to working`, async () => {
    const s = withExecutor()
    const id = addRow(s.store, from)
    expect(await s.ex.prompt(s.store.get(id)!, 'more', 'followup')).toMatchObject({ ok: true, data: { state: 'working' } })
    expect(s.sent).toHaveLength(1)
  })
}

test('accepted agent.close ends closed: the exit event during close is a no-op', async () => {
  const s = withExecutor()
  const id = addRow(s.store, 'accepted')
  expect(await s.ex.close(s.store.get(id)!, 'merged', false)).toMatchObject({ ok: true, data: { state: 'closed', endReason: 'merged' } })
})

test('policy: every state Stop may leave does leave on hook.Stop', () => {
  const stoppable = (Object.keys(AGENT_TRANSITIONS) as AgentState[]).filter((st) => canTransition(st, 'candidate_done'))
  expect(stoppable).toContain('working')
  for (const from of stoppable) {
    const s = setup()
    const id = addRow(s.store, from)
    s.bus.publish(event('hook.Stop'))
    expect(s.store.get(id)?.state).toBe('candidate_done')
  }
})

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function boot(agents: string) {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-pty-watch-'))
  dirs.push(dir)
  const env = { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: agents, WEBTERM_DATA_DIR: dir, HOME: dir }
  const h = bootCa2({ runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions: {} as unknown as SessionsLike, registry: createRegistry(), noTimer: true, dataDirPath: dir, now, env })
  if (!h) throw new Error('boot failed')
  return h
}

const CENTRAL = new Set(['central'] as const)
const NONE = new Set<never>()

test('policy: boot wires the process bus, so a live pty row cannot reach Stop without moving', () => {
  const h = boot('propose')
  try {
    const store = h.executor!.store
    const id = addRow(store, 'working')
    eventBus.publish(event('hook.Stop'))
    expect(store.get(id)?.state).toBe('candidate_done')
  } finally { h.stop(); setActiveCa2(null) }
})

test('boot: start is idempotent, pause unsubscribes, a bounce subscribes once', async () => {
  const h = boot('propose')
  try {
    await reconcile(NONE, CENTRAL)
    const store = h.executor!.store
    const audited = (phase: string) => eventKinds(h.db, 'central.agent').filter((p) => p['phase'] === phase).length
    const realGet = store.get
    let lookups = 0
    store.get = (agentId) => { lookups += 1; return realGet(agentId) }
    // Moves guard themselves, so a doubled subscription adds no move or audit row; only its extra row lookup shows.
    const publish = (kind: string, nodeId: string) => { lookups = 0; eventBus.publish(event(kind, {}, nodeId)); return lookups }

    const first = addRow(store, 'working')
    publish('hook.Stop', NODE)
    expect(store.get(first)?.state).toBe('candidate_done')
    expect(publish('hook.Stop', NODE)).toBe(1)
    expect(audited('pty.candidate_done')).toBe(1)
    publish('hook.UserPromptSubmit', NODE)
    expect(store.get(first)?.state).toBe('working')
    expect(audited('pty.working')).toBe(1)

    await reconcile(CENTRAL, NONE)
    expect(publish('hook.Stop', NODE)).toBe(0)
    expect(store.get(first)?.state).toBe('working')
    expect(audited('pty.candidate_done')).toBe(1)

    await reconcile(NONE, CENTRAL)
    await h.ready
    // The re-arm sweep may end `first`, which has no session; a row made after it cannot be touched.
    const second = addRow(store, 'working', { id: 'ag2', nodeId: 'node-2' })
    publish('hook.Stop', 'node-2')
    expect(store.get(second)?.state).toBe('candidate_done')
    expect(publish('hook.Stop', 'node-2')).toBe(1)
    expect(audited('pty.candidate_done')).toBe(2)

    h.stop()
    expect(publish('hook.UserPromptSubmit', 'node-2')).toBe(0)
    expect(store.get(second)?.state).toBe('candidate_done')
    expect(audited('pty.working')).toBe(1)
  } finally { h.stop(); setActiveCa2(null) }
})

test('boot: no executor, no subscription', () => {
  const h = boot('off')
  try {
    expect(h.executor).toBeNull()
    const store = createAgentStore(h.db, now)
    const id = addRow(store, 'working')
    eventBus.publish(event('hook.Stop'))
    expect(store.get(id)?.state).toBe('working')
    expect(eventKinds(h.db, 'central.agent')).toEqual([])
  } finally { h.stop(); setActiveCa2(null) }
})
