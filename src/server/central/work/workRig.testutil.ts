// Test-only rig: real ledger schema in memory, fake bus, fake ports, hand-driven clock.
import type { SubmitResult } from '../../agentSubmit'
import { createEventBus } from '../../events/eventBus'
import type { EventTrust, SenseEvent } from '../../events/eventModel'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { WORK_TRANSITIONS } from '../../../shared/centralWork'
import type { AssignmentChannel, AssignmentView, WorkEventView, WorkStatus } from '../../../shared/centralWork'
import type { AgentState } from '../contracts'
import type { WorkStore } from './workModel'
import { createWorkStore } from './workStore'
import { createWorkSupervisor, type WorkSendResult } from './workSupervisor'

export const NODE = 'node-1'
export { T0 }

let seq = 0
export function event(kind: string, payload: unknown = {}, nodeId: string | null = NODE, trust: EventTrust = 'trusted'): SenseEvent {
  seq += 1
  return { seq, ts: T0, kind, source: 'test', actor: 'agent', subject: null, workspaceId: null, nodeId, trust, dedupeKey: null, payload, prevHash: '', hash: '' }
}

/** Fake ports recording what the supervisor did; flip the fields to change the world. */
export function fakePorts() {
  const state = {
    live: true, busy: false, chatGone: false, chatResult: { ok: true } as WorkSendResult,
    agents: {} as Record<string, { state: AgentState; endReason: string | null; lastEventAt?: number | null }>,
    inputs: [] as string[], chats: [] as string[], throwOnInput: false,
    submitResult: { ok: true, started: true } as SubmitResult,
  }
  return {
    state,
    ports: {
      isLive: () => state.live,
      submit: async (_: string, text: string) => { if (state.throwOnInput) throw new Error('pty gone'); state.inputs.push(text); return state.submitResult },
      chatBusy: () => state.busy,
      chatNodeGone: () => state.chatGone,
      chatSend: async (_: AssignmentView, text: string) => { state.chats.push(text); return state.chatResult },
      agentOf: (id: string) => state.agents[id] ?? null,
    },
  }
}

/**
 * Puts a task in `status` by walking the legal edges with `moveTask`, so the owner's lease matches the status
 * exactly as in production. Never set `central_task.status` with raw SQL: that skips the lease (workStore.applyMove).
 */
export function putTaskInStatus(store: WorkStore, taskId: string, status: WorkStatus): void {
  const from = store.getTask(taskId)?.status
  if (!from) throw new Error(`putTaskInStatus: unknown task ${taskId}`)
  const prev = new Map<WorkStatus, WorkStatus>([[from, from]])
  for (const queue = [from]; queue.length > 0 && !prev.has(status);) {
    const cur = queue.shift() as WorkStatus
    for (const next of WORK_TRANSITIONS[cur]) if (!prev.has(next)) { prev.set(next, cur); queue.push(next) }
  }
  if (!prev.has(status)) throw new Error(`putTaskInStatus: no path ${from} -> ${status} for ${taskId}`)
  const path: WorkStatus[] = []
  for (let s = status; s !== from; s = prev.get(s) as WorkStatus) path.unshift(s)
  for (const to of path) store.moveTask(taskId, to, { actor: { kind: 'human', id: 'test' }, rule: 'test_fixture', reason: `fixture -> ${status}` })
}

export function rig() {
  const db = freshDb()
  const clock = { t: T0 }
  const now = () => clock.t
  const store = createWorkStore(db, now)
  const bus = createEventBus()
  const fake = fakePorts()
  const supervisor = createWorkSupervisor({ store, ports: fake.ports, now })
  let n = 0
  /** A task with an open assignment on `nodeId`, forced to `status`. */
  const assigned = (status: WorkStatus = 'assigned', opts: { channel?: AssignmentChannel; agentId?: string; nodeId?: string; acceptance?: 'review' | 'project_checks' } = {}) => {
    n += 1
    const id = `t${n}`
    store.createTask({ id, projectId: 'p1', title: `title ${id}`, objective: 'o', actor: { kind: 'central' }, ...(opts.acceptance ? { acceptance: opts.acceptance } : {}) })
    const assignment = store.openAssignment({ taskId: id, nodeId: opts.nodeId ?? NODE, channel: opts.channel ?? 'terminal', instruction: 'do it', actor: { kind: 'central' }, ...(opts.agentId ? { agentId: opts.agentId } : {}) })
    if (status !== 'assigned') putTaskInStatus(store, id, status)
    return { taskId: id, assignmentId: assignment.id }
  }
  const statusOf = (id: string): WorkStatus | undefined => store.getTask(id)?.status
  const rules = (id: string): WorkEventView[] => store.timeline(id).filter((e) => e.rule !== null)
  const lastRule = (id: string): string | null => rules(id).at(-1)?.rule ?? null
  return { db, clock, store: store as WorkStore, bus, supervisor, fake, assigned, statusOf, rules, lastRule, now }
}
