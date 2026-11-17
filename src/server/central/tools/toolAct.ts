// "Central never acts silently": a successful tool call that changes a node tells the UI (`t:'act'`) and leaves a
// Senses record (`central.act`). Ids and a verb only: never arguments, prompts, typed text, URLs or results (Rule 12).
import type { ActMsg } from '../../../shared/protocol'
import { isSafeNodeId } from '../../../shared/workspace.ids'
import type { AppendEventInput } from '../../events/eventModel'
import { recordEvent } from '../../events/producers'
import { createLogger } from '../../logs'
import { projectWorkspaceId } from '../workspaceLookup'
import type { ToolCtx, ToolResult } from './toolTypes'

const log = createLogger('central')

/** Event kind of the record; source and actor are `central`. */
export const ACT_EVENT_KIND = 'central.act'
/** Frames for one (node, verb) inside this window fold into one with a higher `n`. */
export const ACT_COALESCE_MS = 1000
/** Most (node, verb) pairs held at once; beyond it a call is sent at once instead of waiting (bounded memory). */
export const ACT_MAX_PENDING = 200
const MAX_HOST = 253

/** Tools whose success changes a node the user can see, with the past-tense verb the UI shows. `canvas.show` is absent: it already moves the camera. */
export const ACT_TOOLS: Readonly<Record<string, string>> = {
  'agent.spawn': 'spawned', 'agent.prompt': 'prompted', 'agent.relay': 'queued', 'agent.close': 'closed',
  'canvas.open': 'opened', 'canvas.reopen': 'opened', 'canvas.camera': 'framed', 'canvas.type': 'typed', 'canvas.close': 'closed', 'canvas.edit': 'wired',
  browser_open: 'opened', browser_act: 'drove', browser_read: 'drove', 'chat.send': 'sent', 'permission.decide': 'answered', 'task.assign': 'assigned',
  'chat.config': 'configured', 'chat.mode': 'switched',
}

const PROPOSAL = 'only proposes; a human or another tool acts, and that tool announces'
const BOARD_ONLY = 'changes the board or task list, not a node; the board push already shows it'
const CENTRAL_STATE = "writes Central's own notes or schedule; no node is touched"

/** Registered tools above R0 that are deliberately not announced, each with the reason (policy test: a new silent tool fails). */
export const NO_ACT: Readonly<Record<string, string>> = {
  'canvas.show': 'already moves the camera to the node (t:view)',
  'canvas.group': 'layout only; the canvas push already moves the tabs',
  'workspace.switch': 'switches the board the user sees; the view frame itself is the visible change',
  'workspace.create': BOARD_ONLY, 'workspace.rename': BOARD_ONLY,
  'task.create': BOARD_ONLY, 'task.update': BOARD_ONLY, 'task.cancel': BOARD_ONLY,
  'goal.propose': PROPOSAL, 'plan.propose': PROPOSAL, 'approval.request': PROPOSAL, 'skill.propose': PROPOSAL,
  'blackboard.propose': PROPOSAL, 'channel.bot.propose': PROPOSAL,
  'playbook.review': 'chains task.create and agent.spawn, which announce themselves',
  'playbook.code_change': 'chains task.create and agent.spawn, which announce themselves',
  'playbook.skill_authoring': 'chains task.create and agent.spawn, which announce themselves',
  'playbook.web_research': 'chains task.create and agent.spawn, which announce themselves',
  'memory.remember': CENTRAL_STATE, 'memory.update': CENTRAL_STATE, 'memory.forget': CENTRAL_STATE, 'memory.remember_user': CENTRAL_STATE,
  'state.update': CENTRAL_STATE, 'reminder.set': CENTRAL_STATE, 'reminder.cancel': CENTRAL_STATE,
  'health.scan': 'starts a read-only scan of a project; no node is touched', 'health.analyze': 'starts a read-only analysis of a project; no node is touched',
}

/** Where a result's action landed; null when it names no node (nothing to point at). */
function nodesOf(tool: string, data: Record<string, unknown>): { nodeId: string; nodeId2?: string } | null {
  if (data['reused'] === true || data['already'] === true || data['alreadyOpen'] === true) return null
  const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : undefined)
  const id = (v: unknown): string => (typeof v === 'string' ? v : '') // '' fails isSafeNodeId
  if (tool === 'canvas.open' || tool === 'canvas.reopen' || tool === 'canvas.close') return { nodeId: id(first(data['ids'])) }
  if (tool === 'canvas.edit') {
    const pair = first(data['wired'])
    return Array.isArray(pair) ? { nodeId: id(pair[0]), nodeId2: id(pair[1]) } : null
  }
  const nodeId = id(data['nodeId'])
  return tool === 'browser_open' && typeof data['agentNode'] === 'string' ? { nodeId, nodeId2: data['agentNode'] } : { nodeId }
}

export interface ActSink {
  record(event: AppendEventInput): void
  broadcast(msg: ActMsg): void
}

let broadcastFn: ((msg: ActMsg) => void) | null = null
/** server.main registers the UI broadcaster; before that frames go nowhere (the record is still written). */
export function registerActBroadcast(fn: (msg: ActMsg) => void): void { broadcastFn = fn }

const liveSink: ActSink = { record: recordEvent, broadcast: (msg) => broadcastFn?.(msg) }

interface Pending { msg: ActMsg; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>()

/** Writes the record and the frame; each side is isolated so a dead ledger still broadcasts and neither reaches the tool. */
function emit(sink: ActSink, msg: ActMsg, ctx: Pick<ToolCtx, 'conversationId'>): void {
  const { v, tool, verb, nodeId, nodeId2, workspaceId, turnId, host, n } = msg
  try {
    sink.record({
      kind: ACT_EVENT_KIND, source: 'central', actor: 'central', subject: `node:${nodeId}`, nodeId, ...(workspaceId ? { workspaceId } : {}), trust: 'trusted',
      payload: { v, tool, verb, nodeId, ...(nodeId2 ? { nodeId2 } : {}), ...(turnId ? { turnId } : {}), ...(host ? { host } : {}), n },
    })
  } catch (err) {
    log.warn('central.act.record_failed', 'central.act record failed; frame still sent', { tool, conversationId: ctx.conversationId, cause: err instanceof Error ? err.name : 'unknown' })
  }
  try {
    sink.broadcast(msg)
  } catch (err) {
    log.warn('central.act.broadcast_failed', 'central.act frame failed', { tool, conversationId: ctx.conversationId, cause: err instanceof Error ? err.name : 'unknown' })
  }
}

/**
 * Announces one successful tool effect on a node. Trailing coalescer per (node, verb): a burst becomes one frame
 * with `n` = calls. Never throws; failed or unlisted calls announce nothing.
 */
export function announceCentralAct(ctx: ToolCtx, tool: string, projectId: string | undefined, result: ToolResult, sink: ActSink = liveSink): void {
  const verb = ACT_TOOLS[tool]
  if (!verb || !result.ok || !result.data) return
  try {
    const nodes = nodesOf(tool, result.data)
    if (!nodes || !isSafeNodeId(nodes.nodeId) || (nodes.nodeId2 !== undefined && !isSafeNodeId(nodes.nodeId2))) return
    const key = `${nodes.nodeId}|${verb}`
    const held = pending.get(key)
    if (held) { held.msg.n += 1; return }
    const host = tool === 'browser_act' && typeof result.data['host'] === 'string' ? result.data['host'].slice(0, MAX_HOST) : undefined
    const workspaceId = projectId ? projectWorkspaceId(ctx.db, projectId) : null
    const msg: ActMsg = {
      t: 'act', v: 1, tool, verb, ...nodes, ...(workspaceId ? { workspaceId } : {}), ...(ctx.turnId ? { turnId: ctx.turnId } : {}), ...(host ? { host } : {}), n: 1,
    }
    if (pending.size >= ACT_MAX_PENDING) { emit(sink, msg, ctx); return }
    const timer = setTimeout(() => { pending.delete(key); emit(sink, msg, ctx) }, ACT_COALESCE_MS)
    timer.unref?.()
    pending.set(key, { msg, timer })
  } catch (err) {
    log.warn('central.act.failed', 'central.act could not be announced', { tool, conversationId: ctx.conversationId, cause: err instanceof Error ? err.name : 'unknown' })
  }
}

/** Test seam: drops every held entry without emitting. */
export function resetActCoalescer(): void {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
}
