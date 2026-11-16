// The result a worker leaves when its turn ends: built, redacted and capped here, stored by workStore as
// `central_assignment.result_json`. Pure except the in-process stash that carries the Stop payload from the
// hook route to the work watcher without widening the (append-only) event ledger with long text.
import { createHash } from 'node:crypto'
import { redactSecrets } from '../../redactSecrets'
import { type FailureKind, failureKindOfStop } from './workFailureKind'

/** Longest result text kept per assignment (bytes, after redaction); the rest is cut and flagged `truncated`. */
export const RESULT_MAX_BYTES = 8 * 1024
/** Longest failure detail kept from a StopFailure payload. */
export const FAILURE_DETAIL_MAX_CHARS = 500
const RESULT_LINE_RE = /^[ \t]*RESULT:/im

export type ResultSource = 'stop_hook' | 'transcript' | 'agent_report' | 'exec_tail' | 'none'

export interface WorkResult {
  source: ResultSource
  text: string
  /** From the last `RESULT:` marker to the end of the message; absent when the agent wrote none. */
  resultLine?: string
  truncated: boolean
  at: number
  /** sha256 of the redacted full text: the same message sent twice (claude --resume) is stored once. */
  hash: string
  /** Why there is no text (`source: 'none'`), or why the turn failed. */
  reason?: string
  /** `kind` lets a later sweep pick the fix (wait out a network drop, ask a human for a login). */
  failure?: { error: string; details?: string; kind?: FailureKind }
}

const RANK: Record<ResultSource, number> = { none: 0, exec_tail: 1, agent_report: 2, transcript: 3, stop_hook: 3 }

/** Whether `incoming` may replace `existing`: never with a poorer source (a Stop capture beats a `--done` text beats an exec tail beats nothing); equals replace. */
export function mayReplaceResult(existing: Pick<WorkResult, 'source'> | null, incoming: Pick<WorkResult, 'source'>): boolean {
  return existing === null || RANK[incoming.source] >= RANK[existing.source]
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function capBytes(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= RESULT_MAX_BYTES) return { text, truncated: false }
  return { text: buf.subarray(0, RESULT_MAX_BYTES).toString('utf8').replace(/�+$/, ''), truncated: true }
}

/** The `RESULT:` section of a message (last marker wins), or undefined. */
export function resultLineOf(text: string): string | undefined {
  let at = -1
  for (const m of text.matchAll(new RegExp(RESULT_LINE_RE.source, 'gim'))) at = m.index ?? at
  return at < 0 ? undefined : text.slice(at).replace(/^[ \t]*RESULT:[ \t]*/i, '').trim()
}

/** Redacts, caps and hashes `text`; blank text becomes an explicit `none` result instead of an empty one. */
export function buildResult(source: Exclude<ResultSource, 'none'>, text: string, at: number): WorkResult {
  const clean = redactSecrets(text).trim()
  if (!clean) return noResult('empty_message', at)
  const capped = capBytes(clean)
  const line = resultLineOf(capped.text)
  return { source, text: capped.text, ...(line ? { resultLine: line } : {}), truncated: capped.truncated, at, hash: sha(clean) }
}

/** An explicit "nothing captured" result: every `reported` task carries one of these or real text, never silence. */
export function noResult(reason: string, at: number, failure?: WorkResult['failure']): WorkResult {
  return { source: 'none', text: '', truncated: false, at, hash: sha(`none:${reason}:${failure?.error ?? ''}`), reason, ...(failure ? { failure } : {}) }
}

/** Text of the last assistant message in a claude transcript JSONL (tail may start mid-line); null when none. */
export function lastAssistantText(raw: string): string | null {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: { type?: string; message?: { content?: unknown } }
    try { o = JSON.parse(lines[i] as string) } catch { continue }
    if (o?.type !== 'assistant' || !Array.isArray(o.message?.content)) continue
    const text = (o.message.content as { type?: string; text?: string }[]).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
    if (text.trim()) return text
  }
  return null
}

/** What a Stop / StopFailure hook body yields; `body` is untrusted. `readTranscript` is injected (fs) for the old-claude fallback. */
export function captureFromHook(body: Record<string, unknown>, at: number, transcriptPath: string | undefined, readTranscript: (p: string) => string | null): WorkResult {
  if (body.hook_event_name === 'StopFailure') {
    const error = typeof body.error === 'string' ? body.error : 'unknown'
    const d = typeof body.error_details === 'string' ? redactSecrets(body.error_details).slice(0, FAILURE_DETAIL_MAX_CHARS) : undefined
    return noResult('stop_failure', at, { error: redactSecrets(error).slice(0, FAILURE_DETAIL_MAX_CHARS), ...(d ? { details: d } : {}), kind: failureKindOfStop(error, d) })
  }
  if (typeof body.last_assistant_message === 'string') return buildResult('stop_hook', body.last_assistant_message, at)
  if (!transcriptPath) return noResult('no_message_in_payload', at)
  const raw = readTranscript(transcriptPath)
  const text = raw === null ? null : lastAssistantText(raw)
  return text === null ? noResult(raw === null ? 'transcript_unreadable' : 'transcript_has_no_assistant_text', at) : buildResult('transcript', text, at)
}

const stash = new Map<string, WorkResult>()

/** Route side: parks the capture of node's latest Stop/StopFailure for the watcher (one slot per node, overwritten). */
export function stashStopResult(nodeId: string, result: WorkResult): void { stash.set(nodeId, result) }

/** Watcher side: takes (and clears) the parked capture; undefined when this stop came from another channel. */
export function takeStopResult(nodeId: string): WorkResult | undefined {
  const r = stash.get(nodeId)
  stash.delete(nodeId)
  return r
}
