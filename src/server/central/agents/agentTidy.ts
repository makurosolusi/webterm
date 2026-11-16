// Tidies the canvas of Central's finished workers: park (collapse + hide cables), then close, never anything the user owns.
// Rule: only act when sure. Any doubt (unsettled task, open assignment, impaired system, user looking at it) = leave it.
import type { Database } from 'bun:sqlite'
import { type EventBus, eventBus } from '../../events/eventBus'
import type { SenseEvent } from '../../events/eventModel'
import { appendEvent } from '../../ledger/ledgerEvent'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import type { CanvasPush, NodePatch } from '../../canvas/canvasPush'
import { isContextCapable } from '../../../shared/workspace'
import { automaticAction, type AutomaticActionDeps } from '../automaticAction'
import { PROJECT_PAUSED } from '../centralModel'
import type { AgentRecord } from '../contracts'
import { agentNodeId, isCentralOwned, type AgentExecutor } from './agentExecutor'

const log = createLogger('central.tidy')
/** Sweep period; the work per pass is a handful of indexed reads. */
export const TIDY_SWEEP_MS = 60_000
// guess: values are untuned; revisit with real usage (how long users keep reading a finished worker).
export const PARK_AFTER_MS = 15 * 60_000
export const CLOSE_AFTER_MS = 2 * 60 * 60_000
export const MAX_IDLE_PER_PROJECT = 2
/** guess: over the idle limit, an agent is closed only once it has been idle this long (a just-finished one stays readable). */
export const IDLE_GRACE_MS = 5 * 60_000
const DEAD_LOOKBACK_MS = 3 * 24 * 60 * 60_000
const DEAD_BATCH = 30
const MAX_UNDO_IDS = 20
const TIDY_EVENT = 'central.tidy'
const BROWSER_PREFIX = 'br-'
/** Task states whose result the user has (or never needs); everything else may still be worked on. */
const REVIEWED = ['done', 'cancelled', 'failed']
const SETTLED = ['reported', 'needs_review', ...REVIEWED]
const WAKE_HOOKS = ['hook.UserPromptSubmit', 'hook.PreToolUse', 'hook.PostToolUse']
const CLOSE_REASON = 'tidy_idle'
export const UNPARK_PATH = '/api/central/tidy/unpark'

export interface AgentTidyDeps {
  db: Database
  now(): number
  executor(): AgentExecutor | null
  canvas(): CanvasPush | undefined
  /** Node the user is on right now (PresenceTracker.focusedNode). */
  focused(): { nodeId: string } | null
  /** Settings `centralTidy`, read every sweep. */
  enabled(): boolean
  /** Connectivity impaired: do nothing. */
  impaired(): boolean
  /** Lease holder of a browser node; undefined = page not live. */
  browserLease?(nodeId: string): 'agent' | 'human' | undefined
  notify?: Pick<AutomaticActionDeps, 'record'>
  bus?: EventBus
}

export interface TidyReport { parked: number; closed: number }
export interface AgentTidy {
  sweep(): Promise<TidyReport>
  /** Opens parked agents again (the notice's Undo); returns how many were parked. */
  unpark(agentIds: readonly string[]): number
  stop(): void
}

interface Prior { collapsed?: boolean; hideLinks?: boolean }
interface Last { action: string; ts: number; prior: Record<string, Prior> }
type Board = NonNullable<ReturnType<CanvasPush['workspaceOfNode']>>

/** Builds the tidy; `start` of the timer is the caller's (ca2Boot). */
export function createAgentTidy(deps: AgentTidyDeps): AgentTidy {
  const { db, now } = deps
  const parkedNodes = new Set<string>()
  const failed = new Set<string>()
  let running = false

  const lastOf = (agentId: string): Last | null => {
    const r = getRow(db, 'SELECT ts, payload_json FROM event WHERE kind = ? AND correlation_id = ? ORDER BY seq DESC LIMIT 1', TIDY_EVENT, agentId)
    if (!r) return null
    const p = JSON.parse(String(r.payload_json)) as { action?: unknown; prior?: Record<string, Prior> }
    return { action: String(p.action), ts: Number(r.ts), prior: p.prior ?? {} }
  }
  const record = (a: AgentRecord, action: string, reason: string, extra: Record<string, unknown> = {}): void => {
    appendEvent({ db, now }, { kind: TIDY_EVENT, actor: 'central', projectId: a.projectId, correlationId: a.id, payload: { action, agentId: a.id, nodeId: a.nodeId ?? agentNodeId(a.id), reason, ...extra } })
  }
  const paused = (projectId: string): boolean => getRow(db, 'SELECT status FROM project WHERE id = ?', projectId)?.status === PROJECT_PAUSED
  const nodeOf = (a: AgentRecord): string => a.nodeId ?? agentNodeId(a.id)

  /** The task is finished AND its result was delivered, with no assignment left open on the node (recovery in flight). */
  const settled = (a: AgentRecord): boolean => {
    if (getRow(db, 'SELECT 1 AS x FROM central_assignment WHERE ended_at IS NULL AND (node_id = ? OR agent_id = ?) LIMIT 1', nodeOf(a), a.id)) return false
    if (!a.taskId) return false
    const status = String(getRow(db, 'SELECT status FROM central_task WHERE id = ?', a.taskId)?.status ?? '')
    if (!SETTLED.includes(status)) return false
    const r = getRow(db, 'SELECT COUNT(*) AS total, COALESCE(SUM(sent_at IS NULL), 0) AS unsent FROM central_checkin_reason WHERE task_id = ?', a.taskId)
    return Number(r?.unsent ?? 0) === 0 && (Number(r?.total ?? 0) > 0 || REVIEWED.includes(status))
  }
  const idleSince = (a: AgentRecord, last: Last | null): number => Math.max(a.lastEventAt ?? a.startedAt ?? 0, last?.action === 'unpark' ? last.ts : 0)

  /** Browser nodes cabled to the agent that Central made (id `br-`), idle, and not on the user's screen. */
  const idleBrowsers = (ws: Board, node: string): string[] => {
    const focus = deps.focused()?.nodeId
    const ends = ws.bridges.filter((b) => b.source === node || b.target === node).map((b) => (b.source === node ? b.target : b.source))
    return [...new Set(ends)].filter((id) => id.startsWith(BROWSER_PREFIX) && ws.nodes.some((n) => n.id === id && n.kind === 'browser') && id !== focus && deps.browserLease?.(id) !== 'agent')
  }

  const patchOf = (ws: Board, node: string, browsers: string[]): { patches: NodePatch[]; prior: Record<string, Prior> } => {
    const patches: NodePatch[] = []
    const prior: Record<string, Prior> = {}
    for (const id of [node, ...browsers]) {
      const n = ws.nodes.find((x) => x.id === id)
      if (!n) continue
      prior[id] = { ...(n.collapsed !== undefined ? { collapsed: n.collapsed } : {}), ...(n.hideLinks !== undefined ? { hideLinks: n.hideLinks } : {}) }
      patches.push({ id, collapsed: true, ...(id === node && n.kind === 'agent' && isContextCapable(n.agentId) ? { hideLinks: true } : {}) })
    }
    return { patches, prior }
  }

  const park = (a: AgentRecord, ws: Board, reason: string): boolean => {
    const push = deps.canvas()
    const node = nodeOf(a)
    if (!push) return false
    const { patches, prior } = patchOf(ws, node, idleBrowsers(ws, node))
    const res = push.update({ workspaceId: ws.id, patches })
    if (!res.ok) {
      if (!failed.has(a.id)) log.warn('tidy.park_refused', `agent ${a.id} could not be parked: ${res.code}`, { agentId: a.id, projectId: a.projectId, code: res.code })
      failed.add(a.id)
      return false
    }
    parkedNodes.add(node)
    record(a, 'park', reason, { prior })
    return true
  }

  const restore = (a: AgentRecord, last: Last, reason: string): boolean => {
    const push = deps.canvas()
    const node = nodeOf(a)
    parkedNodes.delete(node)
    const ws = push?.workspaceOfNode(node)
    if (push && ws) {
      const patches: NodePatch[] = Object.entries(last.prior).filter(([id]) => ws.nodes.some((n) => n.id === id))
        .map(([id, p]) => ({ id, collapsed: p.collapsed ?? null, ...(id === node ? { hideLinks: p.hideLinks ?? null } : {}) } as NodePatch))
      if (patches.length) push.update({ workspaceId: ws.id, patches })
    }
    record(a, 'unpark', reason)
    return true
  }

  /** agent.close through the executor (guard + audit), then the node and its idle Central browsers leave the board. */
  const close = async (a: AgentRecord, reason: string): Promise<boolean> => {
    const ex = deps.executor()
    const push = deps.canvas()
    if (!ex || !push) return false
    const node = nodeOf(a)
    const ws = push.workspaceOfNode(node)
    if (!a.endedAt) {
      if (await ex.gate(a.projectId, 'agent.close', 'R1')) return false
      const res = await ex.close(a, CLOSE_REASON, false)
      if (!res.ok) return false
    }
    parkedNodes.delete(node)
    if (ws) {
      const ids = [...(ws.nodes.some((n) => n.id === node) ? [node] : []), ...idleBrowsers(ws, node)]
      const removed = ids.length ? push.remove({ workspaceId: ws.id, nodeIds: ids }) : { ok: true as const }
      if (!removed.ok) log.warn('tidy.remove_refused', `node of agent ${a.id} not removed: ${removed.code}`, { agentId: a.id, projectId: a.projectId, code: removed.code })
    }
    record(a, 'close', reason)
    return true
  }

  async function pass(): Promise<TidyReport> {
    const report: TidyReport = { parked: 0, closed: 0 }
    const ex = deps.executor()
    const push = deps.canvas()
    if (!deps.enabled() || deps.impaired() || !ex || !push) return report
    const parkedIds: string[] = []
    const t = now()
    const mine = ex.store.listActive().filter((a) => a.runner === 'pty' && isCentralOwned(a))
    const focus = deps.focused()?.nodeId
    // Parked agents that woke up (or whose node the user opened) are opened again / forgotten.
    parkedNodes.clear()
    const idle: AgentRecord[] = []
    for (const a of mine) {
      const last = lastOf(a.id)
      const parked = last?.action === 'park'
      if (last && parked && a.state !== 'candidate_done') { restore(a, last, 'woke'); continue }
      if (a.state !== 'candidate_done') continue
      const ws = push.workspaceOfNode(nodeOf(a))
      if (parked && ws?.nodes.find((n) => n.id === nodeOf(a))?.collapsed !== true) { record(a, 'unpark', 'user_opened'); continue }
      if (parked) parkedNodes.add(nodeOf(a))
      if (!ws || paused(a.projectId) || nodeOf(a) === focus || !settled(a)) continue
      idle.push(a)
    }
    const byProject = new Map<string, AgentRecord[]>()
    for (const a of idle) byProject.set(a.projectId, [...(byProject.get(a.projectId) ?? []), a])
    for (const list of byProject.values()) {
      list.sort((x, y) => idleSince(x, lastOf(x.id)) - idleSince(y, lastOf(y.id)))
      const overflow = new Set(list.slice(0, Math.max(0, list.length - MAX_IDLE_PER_PROJECT)))
      for (const a of list) {
        const last = lastOf(a.id)
        const age = t - idleSince(a, last)
        const parkedFor = last?.action === 'park' ? t - last.ts : -1
        if (parkedFor >= CLOSE_AFTER_MS) { if (await close(a, 'parked_expired')) report.closed++ }
        else if (overflow.has(a) && age >= IDLE_GRACE_MS) { if (await close(a, 'idle_limit')) report.closed++ }
        else if (parkedFor < 0 && age >= PARK_AFTER_MS && park(a, push.workspaceOfNode(nodeOf(a)) as Board, 'idle_after_report')) { report.parked++; parkedIds.push(a.id) }
      }
    }
    // Nodes of workers that ended long ago and still sit on the board.
    const dead = allRows(db, `SELECT id FROM central_agents WHERE runner = 'pty' AND owner LIKE 'central:%' AND ended_at IS NOT NULL AND ended_at < ? AND ended_at > ? ORDER BY ended_at DESC LIMIT ${DEAD_BATCH}`, t - CLOSE_AFTER_MS, t - DEAD_LOOKBACK_MS)
    for (const { id } of dead) {
      const a = ex.store.get(String(id))
      if (!a || !push.workspaceOfNode(nodeOf(a)) || paused(a.projectId) || nodeOf(a) === focus) continue
      if (getRow(db, 'SELECT 1 AS x FROM central_assignment WHERE ended_at IS NULL AND (node_id = ? OR agent_id = ?) LIMIT 1', nodeOf(a), a.id)) continue
      if (a.taskId && !settled(a)) continue
      if (await close(a, 'node_dead')) report.closed++
    }
    announce(report, parkedIds)
    return report
  }

  /** One notice per sweep, however many nodes moved; nothing when nothing happened. */
  function announce(report: TidyReport, parkedIds: string[]): void {
    if (!report.parked && !report.closed) return
    const plural = (n: number): string => `${n} finished worker${n === 1 ? '' : 's'}`
    const parts = [report.parked ? `parked ${plural(report.parked)}` : '', report.closed ? `closed ${plural(report.closed)} (Reopen brings a node back)` : ''].filter(Boolean)
    automaticAction({ db, now, ...(deps.notify?.record ? { record: deps.notify.record } : {}) }, {
      name: 'canvas_tidy', actor: 'central', text: `Tidied the canvas: ${parts.join(', ')}.`, noticeKey: `auto:canvas_tidy:${now()}`,
      ...(parkedIds.length ? { undo: { label: 'Undo', method: 'POST' as const, path: UNPARK_PATH, body: { agentIds: parkedIds.slice(0, MAX_UNDO_IDS) } } } : {}),
    })
  }

  const bus = deps.bus ?? eventBus
  const onHook = (event: SenseEvent): void => {
    if (event.trust !== 'trusted' || !event.nodeId || !parkedNodes.has(event.nodeId) || !WAKE_HOOKS.includes(event.kind)) return
    if ((event.payload as { subagent?: unknown } | null)?.subagent) return
    try {
      const a = deps.executor()?.store.listActive().find((x) => nodeOf(x) === event.nodeId)
      const last = a ? lastOf(a.id) : null
      if (a && last?.action === 'park') restore(a, last, 'woke')
    } catch (err) {
      log.error('tidy.unpark_failed', `parked node ${event.nodeId} could not be opened on wake`, { nodeId: event.nodeId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const off = bus.subscribe('hook.*', onHook)

  return {
    async sweep() {
      if (running) return { parked: 0, closed: 0 }
      running = true
      try { return await pass() } catch (err) {
        log.error('tidy.sweep_failed', 'canvas tidy sweep failed', { error: err instanceof Error ? err.message : String(err) })
        return { parked: 0, closed: 0 }
      } finally { running = false }
    },
    unpark(agentIds) {
      let n = 0
      for (const id of agentIds.slice(0, MAX_UNDO_IDS)) {
        const a = deps.executor()?.store.get(id)
        const last = a ? lastOf(a.id) : null
        if (a && last?.action === 'park' && restore(a, last, 'user_undo')) n++
      }
      return n
    },
    stop: off,
  }
}
