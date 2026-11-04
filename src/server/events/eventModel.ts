// Senses event log: types and the pure hashing rules (no I/O, no bun:sqlite, vitest-safe).
//
// Imitated designs:
// - Certificate Transparency (RFC 6962/9162) and sigstore Rekor: an append-only log whose head
//   ("signed tree head") is published outside the log so a rewritten history is noticed. Here the
//   structure is a linear hash chain (each row commits to `prev_hash`), not a Merkle tree: a
//   single local writer never needs inclusion proofs, only "is the history I saw still intact".
// - RFC 8785 (JSON Canonicalization Scheme): keys sorted by UTF-16 code unit, ECMAScript number
//   serialisation, so the same event always hashes the same bytes.
// - Claude Code hooks event catalog: hook events are recorded as `hook.<HookEventName>` verbatim
//   (`hook.PreToolUse`, `hook.PostToolUse`, `hook.Stop`, `hook.SubagentStop`, `hook.Notification`,
//   `hook.UserPromptSubmit`, `hook.SessionStart`, `hook.SessionEnd`, `hook.PreCompact`, ...);
//   other families follow the same `<family>.<name>` shape (`pty.exit`, `fs.change`, `edge.change`).
import { createHash } from 'node:crypto'

/** Taint label (PLAN S3): content from browser/web/third-party output is `untrusted`. */
export type EventTrust = 'trusted' | 'untrusted'

/** Input for `EventLog.append`. */
export interface AppendEventInput {
  /** `<family>.<name>`, e.g. `hook.PostToolUse`, `pty.exit`, `fs.change`. */
  kind: string
  /** Producer module, e.g. `agentStatusApi`, `pty`, `fsWatch`. */
  source: string
  /** Principal that caused it (`human-ui`, `central`, `node:<id>`, ...); defaults to `source`. */
  actor?: string
  /** What it is about, free-form ref such as `node:<id>` or `path:<rel>`. */
  subject?: string | null
  workspaceId?: string | null
  nodeId?: string | null
  trust: EventTrust
  /** JSON-serialisable; producers redact secrets before calling. */
  payload?: unknown
  /** Same key within the dedupe window returns the earlier row instead of appending. */
  dedupeKey?: string | null
  ts?: number
}

/** One chained row of the `event` table. */
export interface SenseEvent {
  seq: number
  ts: number
  kind: string
  source: string
  actor: string
  subject: string | null
  workspaceId: string | null
  nodeId: string | null
  trust: EventTrust
  dedupeKey: string | null
  payload: unknown
  prevHash: string
  hash: string
}

export interface AppendResult {
  event: SenseEvent
  /** True when an earlier row with the same dedupe key was returned and nothing was written. */
  deduped: boolean
}

export interface ChainHead {
  seq: number
  hash: string
}

export type VerifyResult =
  | { ok: true; checked: number; head: ChainHead | null }
  | {
      ok: false
      checked: number
      head: ChainHead | null
      brokenAt: { seq: number; reason: 'prev_hash_mismatch' | 'hash_mismatch' }
    }

/** prev_hash of the first chained row (Bitcoin-style all-zero genesis). */
export const GENESIS_HASH = '0'.repeat(64)

/** RFC 8785-style canonical JSON. Throws on values JSON cannot represent faithfully. */
export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON(): unknown }).toJSON())
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: non-finite number ${value}`)
  }
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    if (text === undefined) throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
    return text
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}

/** Exactly the stored columns a chained row's hash commits to (seq is excluded: order is the chain). */
export interface HashedColumns {
  prev_hash: string
  ts: number
  kind: string
  source: string
  actor: string
  subject: string | null
  workspace_id: string | null
  node_id: string | null
  trust: string
  dedupe_key: string | null
  payload_json: string | null
}

/** sha256 hex over the canonical JSON of the row's columns, prev_hash included. */
export function chainHash(columns: HashedColumns): string {
  return createHash('sha256').update(canonicalJson(columns)).digest('hex')
}
