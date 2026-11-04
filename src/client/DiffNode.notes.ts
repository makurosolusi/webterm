// Review notes on a diff and their delivery to the wired agent as ONE message.
// Format copied from Orca `src/shared/diff-comments-format.ts` (deterministic, quote-safe).
// Delivery goes through the server OUTBOX (`enqueueNotes` -> `POST /api/outbox`, src/server/outbox/):
// queued while the agent is busy, typed at the end of its turn into a proven-empty composer, exactly
// once per operationId even when the request is retried.
import type { AgentStatus, DiffNoteData } from '../shared/workspace'
import { OUTBOX_PATH, type OutboxEnqueueReply } from '../server/outbox/outbox.types'
import { tokenQuery } from './api'

export type DiffNote = DiffNoteData

/** Gap before the submitting Enter; same measured gap as agentActions `EXIT_KEY_GAP_MS`. */
export const SUBMIT_GAP_MS = 150
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export function formatDiffNote(n: DiffNote): string {
  const escaped = n.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  return [`File: ${n.path}`, n.line === 0 ? 'Scope: file' : `Line: ${n.line}`, `User comment: "${escaped}"`].join('\n')
}

/** The batch message: a one-line lead so the agent knows what it is reading, then every note. */
export function formatDiffNotes(notes: readonly DiffNote[]): string {
  return [`[webterm] Review notes on your working-tree diff (${notes.length}):`, ...notes.map(formatDiffNote)].join('\n\n')
}

/** Why the batch cannot be delivered now, or null when it can. */
export function sendRefusal(agentId: string | null, status: AgentStatus | undefined, count: number): string | null {
  if (!agentId) return 'Wire an agent to this node to send notes.'
  if (count === 0) return 'Add a note first.'
  if (status === 'working') return 'The agent is working; send when its turn ends.'
  if (status === 'blocked') return 'The agent is waiting on a permission prompt.'
  return null
}

/** Retry-safe operation id: a batch's first note is sent only once, so a retried send of the same
 *  batch is the same operation and the server dedupes it. */
export const notesOperationId = (agentId: string, notes: readonly DiffNote[]): string =>
  `diff-notes:${agentId}:${notes[0]?.id ?? 'none'}:${notes.length}`

/** Queue the batch for `agentId` in the server outbox. Throws naming the operation on failure. */
export async function enqueueNotes(agentId: string, notes: readonly DiffNote[], fetchFn: typeof fetch = fetch): Promise<OutboxEnqueueReply> {
  const q = tokenQuery()
  const res = await fetchFn(q ? `${OUTBOX_PATH}?${q}` : OUTBOX_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: agentId, body: formatDiffNotes(notes), operationId: notesOperationId(agentId, notes) }),
  })
  const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: string }
  if (!res.ok) throw new Error(`Send review notes to ${agentId}: ${typeof body.message === 'string' ? body.message : body.error ?? `HTTP ${res.status}`}`)
  return body as OutboxEnqueueReply
}

/** Paste the batch (bracketed paste keeps newlines from submitting) then submit with a separate Enter.
 *  TODO(outbox-diffnotes): delete once DiffNode.tsx `onSend` calls `enqueueNotes` (F2-d; that call
 *  site is outside wkr-out-70's file ownership). */
export async function deliverNotes(
  write: (data: string) => void, text: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  write(`${PASTE_START}${text}${PASTE_END}`)
  await sleep(SUBMIT_GAP_MS)
  write('\r')
}
