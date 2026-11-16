// Test-only rig of the recovery sweep: real ledger and work store, a fake detector, fake timers and a fake world
// (which sessions are live, what resume/respawn answer). Nothing here touches the network or a PTY.
import type { AssignmentChannel, WorkStatus } from '../../../shared/centralWork'
import type { ConnState, ConnectivityEpisode, ConnectivityPort, ConnectivityState } from '../../connectivity/connectivity.port'
import { allRows, getRow } from '../../ledger/ledgerCore'
import type { AgentOwner, AgentRole, AgentRunner, AgentState } from '../contracts'
import type { FailureKind } from './workFailureKind'
import { createRateLimitHold } from './workRateLimit'
import { createWorkRecover, type RecoverTimers } from './workRecover'
import { RECOVER_EVENT, type AgentInfo, type PermitResult, type RecoverPorts, type RespawnResult, type ResumeOutcome, type SweepKey } from './workRecover.model'
import { INTERRUPTED_EVENT } from './workWatcher'
import { rig, T0 } from './workRig.testutil'

export const MIN = 60_000
export { T0 }

export function fakeDetector() {
  const listeners = new Set<(s: ConnectivityState, from: ConnState) => void>()
  const d = {
    down: false, list: [] as ConnectivityEpisode[],
    state: (): ConnectivityState => ({ state: d.down ? 'offline' : 'online', since: T0, lastOkAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0 }),
    isOffline: () => d.down, isImpaired: () => d.down,
    subscribe: (fn: (s: ConnectivityState, from: ConnState) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    emit(to: ConnState, from: ConnState) { listeners.forEach((fn) => fn({ ...d.state(), state: to }, from)) },
    // Newest first, like the real port.
    episodes: (limit: number) => d.list.slice(0, limit),
  }
  return d
}

export function fakeTimers() {
  const queue: { fn: () => void; ms: number; live: boolean }[] = []
  const timers: RecoverTimers = {
    set: (fn, ms) => { const t = { fn, ms, live: true }; queue.push(t); return t },
    clear: (h) => { (h as { live: boolean }).live = false },
  }
  return {
    timers, queue,
    /** Delays of the timers still pending. */
    pending: () => queue.filter((t) => t.live).map((t) => t.ms),
    /** Fires every pending timer once (timers set while firing wait for the next call). */
    fire() { for (const t of queue.filter((x) => x.live)) { t.live = false; t.fn() } },
  }
}

const EPISODE_ID = 'e1'
export const episodeAt = (startedAt: number, endedAt: number | null): ConnectivityEpisode => ({ id: EPISODE_ID, state: 'offline', startedAt, endedAt, durationMs: (endedAt ?? startedAt) - startedAt, cause: 'dns', scope: 'network' })

export function recoverRig() {
  const r = rig()
  const detector = fakeDetector()
  const ticker = fakeTimers()
  const rate = createRateLimitHold()
  const announced: { key: string; text: string }[] = []
  const agents = new Map<string, AgentInfo>()
  const calls = { reprompt: [] as string[], resume: [] as string[], respawn: [] as { taskId: string; reqId: string; title: string }[], brief: [] as string[], chat: [] as string[], submit: [] as string[] }
  const world = {
    live: new Set<string>(), permit: { ok: true } as PermitResult, terminalIdle: true, chatBusy: false, chatGone: false,
    reprompt: { ok: true } as { ok: boolean; code?: string }, resume: { ok: true } as ResumeOutcome,
    respawn: { ok: true, agentId: 'ag-new', nodeId: 'c-ag-new' } as RespawnResult, brief: true,
    chat: { ok: true } as { ok: true } | { ok: false; code: string },
  }
  const ports: RecoverPorts = {
    isLive: (n) => world.live.has(n),
    submit: async (_n, text) => { calls.submit.push(text); return { ok: true, started: true } },
    chatBusy: () => world.chatBusy, chatNodeGone: () => world.chatGone,
    chatSend: async (_a, text) => { calls.chat.push(text); return world.chat },
    permit: () => world.permit,
    agent: (id) => agents.get(id) ?? null,
    terminalIdle: () => world.terminalIdle,
    reprompt: async (id) => { calls.reprompt.push(id); return world.reprompt },
    resume: async (id) => {
      calls.resume.push(id)
      if (world.resume.ok) { const a = agents.get(id); if (a) { a.state = 'working'; world.live.add(a.nodeId as string) } }
      return world.resume
    },
    respawn: async (input) => {
      calls.respawn.push({ taskId: input.taskId, reqId: input.reqId, title: input.title })
      if (world.respawn.ok) { agents.set(world.respawn.agentId, agentInfo(world.respawn.agentId, 'working', world.respawn.nodeId)); world.live.add(world.respawn.nodeId) }
      return world.respawn
    },
    brief: async (_id, text) => { calls.brief.push(text); return world.brief },
  }
  const recover = createWorkRecover({
    db: r.db, store: r.store, now: r.now, ports, rateLimit: rate, timers: ticker.timers,
    connectivity: () => detector, announce: (key, text) => { announced.push({ key, text }) },
  })
  /** An open attempt interrupted `kind` at the current clock; `agentState` set = a spawn agent row with that state (live when `live`). */
  const victim = (opts: { kind?: FailureKind; status?: WorkStatus; channel?: AssignmentChannel; nodeId?: string; agentState?: AgentState; live?: boolean; agentId?: string; note?: boolean } = {}) => {
    const channel = opts.channel ?? 'spawn'
    const agentId = channel === 'spawn' ? opts.agentId ?? `ag${agents.size + 1}` : undefined
    const nodeId = opts.nodeId ?? (agentId ? `c-${agentId}` : `n${agents.size + 1}`)
    const a = r.assigned(opts.status ?? 'running', { channel, nodeId, ...(agentId ? { agentId } : {}) })
    if (agentId) agents.set(agentId, agentInfo(agentId, opts.agentState ?? 'waiting_input', nodeId))
    if (opts.live) world.live.add(nodeId)
    if (opts.note !== false) r.store.noteAssignment(a.assignmentId, INTERRUPTED_EVENT, { rule: 'interrupted', reason: opts.kind ?? 'network' })
    return { ...a, agentId, nodeId }
  }
  const key = (over: Partial<SweepKey> = {}): SweepKey => ({ key: 'episode:e1', window: { from: T0 - 2 * MIN, to: T0 + 12 * MIN }, info: { what: 'connection', episodeId: EPISODE_ID, from: T0, to: T0 + 10 * MIN }, ...over })
  /** The usual story: the link was down T0..T0+10min, victims were hit at T0+1min, the sweep runs at T0+11min. */
  const outage = (): void => { detector.list = [episodeAt(T0, T0 + 10 * MIN)] }
  const recoverEvents = (taskId: string) => allRows(r.db, "SELECT payload_json FROM event WHERE kind = ? AND correlation_id = ? ORDER BY seq", RECOVER_EVENT, taskId).map((x) => JSON.parse(String(x.payload_json)) as Record<string, unknown>)
  const finalOf = (taskId: string): Record<string, unknown> | undefined => recoverEvents(taskId).filter((e) => e.outcome !== 'fallthrough').at(-1)
  const count = (kind: string): number => Number(getRow(r.db, 'SELECT COUNT(*) AS n FROM event WHERE kind = ?', kind)?.n)
  const setNow = (t: number): void => { r.clock.t = t }
  const reasons = () => allRows(r.db, 'SELECT * FROM central_checkin_reason ORDER BY created_at, id')
  return { ...r, setNow, reasons, detector, ticker, rate, announced, agents, calls, world, ports, recover, victim, key, outage, recoverEvents, finalOf, count }
}

export function agentInfo(id: string, state: AgentState, nodeId: string, runner: AgentRunner = 'pty'): AgentInfo {
  return { id, state, runner, kind: 'claude', role: 'worker' as AgentRole, owner: 'central:global' as AgentOwner, nodeId }
}
