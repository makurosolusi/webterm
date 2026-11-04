// Correlated session replay (PLAN F6, buku-ide #136): the pure read-model. Sources (event log,
// transcript JSONL, cost rows) are turned into one ordered list of lane items; no I/O here.
//
// Imitated designs:
// - rrweb Replayer: one timestamp-ordered event chain; seeking to t replays every event <= t
//   synchronously to rebuild the state, and the player is a draggable progress bar (`stateAt`).
// - Langfuse sessions / LangSmith trace view: one row per observation, grouped by session, with
//   cost on the same timeline as the turns and tool calls.
// - Claude Code `/rewind`: a point in the conversation maps to a code checkpoint you can restore;
//   here "Rewind to here" is the existing checkpoint rewind, never a second implementation.
import type { SenseEvent } from '../events/eventModel'

export type Lane = 'transcript' | 'tool' | 'approval' | 'file' | 'browser' | 'cost'
export const LANES: readonly Lane[] = ['transcript', 'tool', 'approval', 'file', 'browser', 'cost']

/** Tie-break order when two sources share a millisecond (keyset pagination depends on it). */
export const SOURCE_RANK = { event: 0, transcript: 1, cost: 2 } as const
export type SourceName = keyof typeof SOURCE_RANK

export interface ReplayItem {
  /** `<source>:<id>`, stable across pages. */
  key: string
  source: SourceName
  /** Event seq, transcript line index, or cost rowid. */
  id: number
  ts: number
  lane: Lane
  nodeId: string | null
  /** One-line, already-redacted label. */
  text: string
  /** Event kind for event items (`hook.PostToolUse`, `checkpoint.created`, ...). */
  kind?: string
  /** Checkpoint seq for `checkpoint.created` (the Rewind target). */
  checkpointSeq?: number
  costMicros?: number
}

export interface Cursor { ts: number; rank: number; id: number }

export const encodeCursor = (c: Cursor): string => `${c.ts}.${c.rank}.${c.id}`
export function decodeCursor(raw: string | null): Cursor | null | 'invalid' {
  if (raw === null || raw === '') return null
  const m = /^(\d{1,15})\.(\d)\.(\d{1,15})$/.exec(raw)
  return m ? { ts: Number(m[1]), rank: Number(m[2]), id: Number(m[3]) } : 'invalid'
}
export const cursorOf = (i: ReplayItem): Cursor => ({ ts: i.ts, rank: SOURCE_RANK[i.source], id: i.id })

/** Total order: ts, then source rank, then per-source id. */
export function compareItems(a: ReplayItem, b: ReplayItem): number {
  return a.ts - b.ts || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.id - b.id
}

/** True when `i` sorts strictly after cursor `c`. */
export function afterCursor(i: ReplayItem, c: Cursor | null): boolean {
  if (!c) return true
  const r = SOURCE_RANK[i.source]
  return i.ts > c.ts || (i.ts === c.ts && (r > c.rank || (r === c.rank && i.id > c.id)))
}

export interface Page { items: ReplayItem[]; nextCursor: string | null }

/**
 * Merges per-source candidate lists (each already filtered to the range and after the cursor, and
 * each holding at most `limit + 1` rows) into one page. `more` comes from any source having more.
 */
export function mergePage(sources: ReadonlyArray<readonly ReplayItem[]>, limit: number): Page {
  const all = sources.flat().sort(compareItems)
  const items = all.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: all.length > limit && last ? encodeCursor(cursorOf(last)) : null }
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const BROWSER_TOOL_RE = /(^|[_.])browser([_.]|$)/i

/** Event kinds the replay reads; the SQL filter in replay.sources.ts mirrors this. */
export const APPROVAL_KINDS = ['permission.request', 'permission.decision', 'inbox.decision', 'policy.decision'] as const

/** Lane of a Senses event; null = not part of the replay. */
export function laneOf(e: Pick<SenseEvent, 'kind' | 'payload'>): Lane | null {
  const p = rec(e.payload)
  if (e.kind === 'hook.PreToolUse' || e.kind === 'hook.PostToolUse' || e.kind === 'mcp.call') {
    return BROWSER_TOOL_RE.test(str(p.toolName) || str(p.tool)) ? 'browser' : 'tool'
  }
  if ((APPROVAL_KINDS as readonly string[]).includes(e.kind)) return 'approval'
  if (e.kind === 'hook.Notification' && str(p.notificationType) === 'permission_prompt') return 'approval'
  if (e.kind.startsWith('checkpoint.') || e.kind === 'fs.change') return 'file'
  if (e.kind.startsWith('hook.')) return 'transcript'
  return null
}

function eventText(e: SenseEvent): string {
  const p = rec(e.payload)
  const tool = str(p.toolName) || str(p.tool)
  switch (e.kind) {
    case 'hook.PreToolUse': return `Tool call: ${tool || 'tool'}`
    case 'hook.PostToolUse': return `Tool done: ${tool || 'tool'}`
    case 'mcp.call': return `Receipt ${tool || 'tool'}: ${str(p.outcome)} (${str(p.detail)})`
    case 'permission.request': return `Approval asked: ${str(p.label) || tool}`
    case 'permission.decision': return `Approval ${str(p.behavior) || 'decided'}: ${str(p.label) || tool}`
    case 'inbox.decision': return `Approval ${str(p.decision) === 'approve' ? 'approved' : 'denied'} in Inbox`
    case 'policy.decision': return `Policy ${str(p.effect)}: ${str(p.capability)}`
    case 'checkpoint.created': return `Checkpoint #${String(p.seq)} (${str(p.reason)})`
    case 'checkpoint.rewound': return `Rewound to checkpoint #${String(p.seq)}`
    case 'checkpoint.unavailable': return 'No checkpoint: folder is not a git repository'
    case 'fs.change': return `Files changed in ${str(p.dir) || 'workspace'}`
    case 'hook.UserPromptSubmit': return `Prompt: ${str(p.preview)}`.trim()
    case 'hook.Stop': return 'Turn finished'
    default: return str(p.preview) ? `${e.kind.slice(5)}: ${str(p.preview)}` : e.kind.slice(5)
  }
}

/** Event row -> replay item; null when it is not on any lane. */
export function eventItem(e: SenseEvent): ReplayItem | null {
  const lane = laneOf(e)
  if (!lane) return null
  const seq = rec(e.payload).seq
  return {
    key: `event:${e.seq}`, source: 'event', id: e.seq, ts: e.ts, lane, nodeId: e.nodeId, text: eventText(e), kind: e.kind,
    ...(e.kind === 'checkpoint.created' && typeof seq === 'number' ? { checkpointSeq: seq } : {}),
  }
}

/** Longest transcript line kept in a replay item (the full turn is in the scrub state). */
export const TRANSCRIPT_TEXT_MAX = 240

export function transcriptItem(nodeId: string, index: number, ts: number, lines: readonly string[]): ReplayItem {
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  return { key: `transcript:${nodeId}:${index}`, source: 'transcript', id: index, ts, lane: 'transcript', nodeId, text: text.length > TRANSCRIPT_TEXT_MAX ? `${text.slice(0, TRANSCRIPT_TEXT_MAX)}…` : text }
}

export interface ScrubState {
  t: number
  /** Last item at or before t (the "playhead"). */
  current: ReplayItem | null
  /** Latest checkpoint at or before t: the target "Rewind to here" passes to the checkpoint API. */
  checkpoint: { seq: number; ts: number } | null
  /** Cost accumulated in the loaded items up to t. */
  costMicros: number
  /** Count per lane up to t. */
  counts: Record<Lane, number>
}

/** rrweb-style seek: fold every item with ts <= t (items must be ordered by `compareItems`). */
export function stateAt(items: readonly ReplayItem[], t: number): ScrubState {
  const counts = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>
  let current: ReplayItem | null = null
  let checkpoint: ScrubState['checkpoint'] = null
  let costMicros = 0
  for (const i of items) {
    if (i.ts > t) break
    current = i
    counts[i.lane] += 1
    if (i.checkpointSeq !== undefined) checkpoint = { seq: i.checkpointSeq, ts: i.ts }
    costMicros += i.costMicros ?? 0
  }
  return { t, current, checkpoint, costMicros, counts }
}
