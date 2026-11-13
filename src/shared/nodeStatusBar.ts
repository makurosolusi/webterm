// Wire contract of `GET /api/node-status?ids=a,b`: what the server knows about a node that its
// stream does not carry (PTY pid and start, hook clocks, cost, outbox, delegation). No prompt text,
// no tokens, no paths: it feeds the node status bar and its "Copy diagnostics".
import type { WorkStatus } from './centralWork'
import type { AgentStatus } from './workspace'
import type { StatusReasonKind } from './protocol'

export const NODE_STATUS_PATH = '/api/node-status'
/** Most ids one request may ask for; the client batches every mounted node into pages of this size. */
export const NODE_STATUS_MAX_IDS = 50

export interface NodeStatusInfo {
  live: boolean
  pid?: number
  /** PTY spawn time (ms). */
  startedAt?: number
  exit?: { code: number; reason: string; at: number }
  status?: AgentStatus
  /** Why the current status needs you or failed; `detail` is short (tool name, capped). */
  reason?: StatusReasonKind
  detail?: string
  /** When the current status began; absent after a server restart until the status changes. */
  statusSince?: number
  /** Last hook write of any status (ms). */
  lastHookAt?: number
  /** Model of the last billed response of the current session. */
  model?: string
  /** Context window used by the last response, 0..100. */
  contextPct?: number
  /** Priced spend of the current session in USD (unpriced responses not counted). */
  costUsd?: number
  outbox?: { queued: number; oldestQueuedAt?: number; lastFailedAt?: number; lastDeliveredAt?: number }
  /** The node's open Central delegation. */
  work?: { title: string; status: WorkStatus; startedAt: number }
}

export interface NodeStatusReply { nodes: Record<string, NodeStatusInfo> }
