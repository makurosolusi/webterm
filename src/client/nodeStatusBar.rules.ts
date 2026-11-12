// Anomaly rules of the node status bar: pure functions over what the page and the server already
// know about one node. Each rule returns one badge (amber `warn` / red `error`) with a one-line
// English reason, or null. Thresholds are named so they can be tuned in one place.
import type { AgentStatus } from '../shared/workspace'
import type { NodeStatusInfo } from '../shared/nodeStatusBar'
import type { ConnectionPhase } from './ws.connection'

/** `working` with no output and no hook for this long = stalled. */
export const STALL_MS = 5 * 60_000
/** Mail still queued after this long = stuck. */
export const OUTBOX_STUCK_MS = 5 * 60_000
/** A delegation still `assigned` (the agent never went to working) after this long. */
export const DELEGATION_START_MS = 2 * 60_000
/** Waiting for a permission answer for longer than this. */
export const BLOCKED_MS = 3 * 60_000
/** Context use at or above this share. */
export const CONTEXT_WARN_PCT = 90

export type AnomalyLevel = 'warn' | 'error'
export interface Anomaly { id: string; level: AnomalyLevel; reason: string }

export interface StatusBarFacts {
  now: number
  connection: ConnectionPhase
  /** Exit as this page saw it, else the server's tombstone. */
  exit?: { code: number; reason?: string; at: number }
  status?: AgentStatus
  statusSince?: number
  lastHookAt?: number
  lastOutputAt?: number
  contextPct?: number
  outbox?: NodeStatusInfo['outbox']
  work?: NodeStatusInfo['work']
}

/** "45s", "12m", "3h 5m", "2d". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

const latest = (...t: (number | undefined)[]): number | undefined => {
  const known = t.filter((x): x is number => x !== undefined)
  return known.length ? Math.max(...known) : undefined
}

/** Exited on its own with a non-zero code, or never started. A close someone asked for is not unexpected. */
export function exitedUnexpectedly(f: StatusBarFacts): Anomaly | null {
  const e = f.exit
  if (!e) return null
  if (e.reason === 'failed') return { id: 'exit', level: 'error', reason: 'The session failed to start.' }
  if (e.reason === 'self' && e.code !== 0) return { id: 'exit', level: 'error', reason: `The session exited unexpectedly with code ${e.code}.` }
  return null
}

export function stalled(f: StatusBarFacts): Anomaly | null {
  if (f.status !== 'working' || f.exit) return null
  const last = latest(f.lastOutputAt, f.lastHookAt, f.statusSince)
  if (last === undefined || f.now - last < STALL_MS) return null
  return { id: 'stalled', level: 'warn', reason: `Working, but no output or hook for ${formatAge(f.now - last)}.` }
}

export function outboxTrouble(f: StatusBarFacts): Anomaly | null {
  const o = f.outbox
  if (!o) return null
  if (o.lastFailedAt !== undefined && o.lastFailedAt > (o.lastDeliveredAt ?? 0)) {
    return { id: 'outbox', level: 'error', reason: 'An outbox delivery failed, and nothing was delivered since.' }
  }
  if (o.queued > 0 && o.oldestQueuedAt !== undefined && f.now - o.oldestQueuedAt >= OUTBOX_STUCK_MS) {
    return { id: 'outbox', level: 'warn', reason: `${o.queued} queued ${o.queued === 1 ? 'message has' : 'messages have'} waited ${formatAge(f.now - o.oldestQueuedAt)} in the outbox.` }
  }
  return null
}

export function delegationNotStarted(f: StatusBarFacts): Anomaly | null {
  const w = f.work
  if (!w || w.status !== 'assigned' || f.status === 'working' || f.now - w.startedAt < DELEGATION_START_MS) return null
  return { id: 'delegation', level: 'warn', reason: `Task assigned ${formatAge(f.now - w.startedAt)} ago, but the agent never started. Prompt may not have been submitted.` }
}

export function blockedTooLong(f: StatusBarFacts): Anomaly | null {
  if (f.status !== 'blocked' || f.statusSince === undefined || f.now - f.statusSince < BLOCKED_MS) return null
  return { id: 'blocked', level: 'warn', reason: `Waiting for your permission for ${formatAge(f.now - f.statusSince)}.` }
}

export function disconnected(f: StatusBarFacts): Anomaly | null {
  switch (f.connection) {
    // The first connect at boot lost nothing yet (same rule as `isDisconnected` in useConnection.ts).
    case 'connected': case 'connecting': return null
    case 'reconnecting': return { id: 'stream', level: 'warn', reason: 'The stream is reconnecting; output may be behind.' }
    case 'offline': return { id: 'stream', level: 'error', reason: 'The browser is offline; the stream is disconnected.' }
    case 'auth': return { id: 'stream', level: 'error', reason: 'The server refused this window; sign in again.' }
  }
}

export function contextFull(f: StatusBarFacts): Anomaly | null {
  if (f.contextPct === undefined || f.contextPct < CONTEXT_WARN_PCT) return null
  return { id: 'context', level: 'warn', reason: `Context is ${Math.round(f.contextPct)}% used; compact or start a new session soon.` }
}

const RULES = [exitedUnexpectedly, disconnected, stalled, blockedTooLong, delegationNotStarted, outboxTrouble, contextFull]

/** Every anomaly of one node, red before amber. */
export function anomaliesOf(f: StatusBarFacts): Anomaly[] {
  const found = RULES.map((r) => r(f)).filter((a): a is Anomaly => a !== null)
  return [...found.filter((a) => a.level === 'error'), ...found.filter((a) => a.level === 'warn')]
}
