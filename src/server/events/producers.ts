// Senses producers (F1-d): hook, PTY exit and file-system signals turned into `event` rows.
// Every producer goes through `recordEvent`, which never throws into its caller: a broken ledger
// must not fail a hook reply, a PTY exit or a file-manager refresh. With no ledger (it failed to
// open) the event is still published on the in-process bus, unrecorded (seq 0, empty hash), so
// linkNote and `wake` keep working.
//
// Redaction rule: payloads carry names, ids, statuses and at most a short scrubbed preview, never a
// prompt body, tool input/output, token or session id (Rule 12).
import type { AgentStatus } from '../../shared/workspace'
import { dataDir } from '../config'
import { redactSecrets } from '../redactSecrets'
import { createLogger } from '../logs'
import { eventBus } from './eventBus'
import type { AppendEventInput, SenseEvent } from './eventModel'
import { activeEventLog } from './eventsRuntime'

const log = createLogger('events')

/** Longest text preview kept from a hook body (`message` / `prompt`). */
export const HOOK_PREVIEW_CHARS = 120
/** Trailing debounce per directory: a build writing for minutes is one row per second, not per write. */
export const FS_EVENT_DEBOUNCE_MS = 1000
/** Names kept per fs.change row; the rest is a count. */
export const FS_EVENT_MAX_NAMES = 20

const HOOK_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const SUBJECT_MAX = 512

/** Appends `input` to the active log; falls back to an unrecorded bus publish. Never throws. */
export function recordEvent(input: AppendEventInput): void {
  try {
    const eventLog = activeEventLog()
    if (eventLog) { eventLog.append(input); return }
  } catch (err) {
    log.warn('events.produce.failed', 'event append failed; published unrecorded', { kind: input.kind, cause: err instanceof Error ? err.message : String(err) })
  }
  eventBus.publish(unrecorded(input))
}

function unrecorded(input: AppendEventInput): SenseEvent {
  return {
    seq: 0,
    ts: input.ts ?? Date.now(),
    kind: input.kind,
    source: input.source,
    actor: input.actor ?? input.source,
    subject: input.subject ?? null,
    workspaceId: input.workspaceId ?? null,
    nodeId: input.nodeId ?? null,
    trust: input.trust,
    dedupeKey: input.dedupeKey ?? null,
    payload: input.payload ?? null,
    prevHash: '',
    hash: '',
  }
}

/** One-line, secret-scrubbed, length-capped preview; null for non-strings/empty. */
export function previewText(value: unknown, max = HOOK_PREVIEW_CHARS): string | null {
  if (typeof value !== 'string') return null
  const flat = redactSecrets(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export interface HookEventInput {
  nodeId: string
  workspaceId?: string | null
  /** Parsed hook stdin JSON (untrusted shape). */
  body: Record<string, unknown>
  status: AgentStatus | null
  /** True when the request carried this node's own token; anything else is `untrusted`. */
  verified: boolean
}

/** `hook.<HookEventName>` from the agent-status route. Unknown/malformed event names are skipped. */
export function produceHookEvent(input: HookEventInput): void {
  const name = input.body.hook_event_name
  if (typeof name !== 'string' || !HOOK_NAME_RE.test(name)) return
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 128 ? v : undefined)
  recordEvent({
    kind: `hook.${name}`,
    source: 'agentStatusApi',
    actor: 'agent',
    subject: `node:${input.nodeId}`,
    nodeId: input.nodeId,
    workspaceId: input.workspaceId ?? null,
    trust: input.verified ? 'trusted' : 'untrusted',
    payload: {
      status: input.status ?? undefined,
      notificationType: str(input.body.notification_type),
      toolName: str(input.body.tool_name),
      subagent: typeof input.body.agent_id === 'string' || undefined,
      preview: previewText(input.body.message ?? input.body.prompt) ?? undefined,
    },
  })
}

export interface PtyExitInput {
  nodeId: string
  agentId?: string
  code: number
  /** `self` = the process ended; `closed` = the node was closed by the user. */
  reason: 'self' | 'closed'
  durationMs: number
}

/** `pty.exit` from the session registry. */
export function producePtyExit(input: PtyExitInput): void {
  recordEvent({
    kind: 'pty.exit',
    source: 'pty',
    actor: input.reason === 'closed' ? 'human-ui' : 'pty',
    subject: `node:${input.nodeId}`,
    nodeId: input.nodeId,
    trust: 'trusted',
    payload: { code: input.code, reason: input.reason, agentId: input.agentId, durationMs: input.durationMs },
  })
}

const fsPending = new Map<string, { names: Set<string>; timer: ReturnType<typeof setTimeout> }>()

/**
 * `fs.change` for a watched directory, trailing-debounced per directory. The writer is unknown:
 * ledger leases name tasks, not paths, so the agent's own writes cannot be told apart. The row is
 * therefore `untrusted` with `cause: 'unknown'`; when leases gain paths, filter them here.
 */
export function produceFsChange(dir: string, names: Iterable<string>, debounceMs = FS_EVENT_DEBOUNCE_MS): void {
  // The ledger (and so this log) lives in the data dir: recording its own writes would loop.
  if (dir === dataDir()) return
  let entry = fsPending.get(dir)
  if (!entry) {
    const timer = setTimeout(() => flushFsChange(dir), debounceMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    entry = { names: new Set(), timer }
    fsPending.set(dir, entry)
  }
  for (const n of names) entry.names.add(n)
}

function flushFsChange(dir: string): void {
  const entry = fsPending.get(dir)
  fsPending.delete(dir)
  if (!entry) return
  const names = [...entry.names].sort()
  recordEvent({
    kind: 'fs.change',
    source: 'fsWatch',
    actor: 'unknown',
    subject: dir.length + 5 <= SUBJECT_MAX ? `path:${dir}` : null,
    trust: 'untrusted',
    payload: { dir, names: names.slice(0, FS_EVENT_MAX_NAMES), more: Math.max(0, names.length - FS_EVENT_MAX_NAMES), cause: 'unknown' },
  })
}
