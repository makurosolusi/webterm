// Review notes on a diff and their delivery to the wired agent as ONE message.
// Format copied from Orca `src/shared/diff-comments-format.ts` (deterministic, quote-safe).
// Delivery uses the agent's own PTY input path (`send({t:'input'})`, as AgentNode's dictation does)
// with the gate of `src/server/linkNoteDelivery.ts`: never into a `working` or `blocked` agent, and
// the Enter goes in a SEPARATE write (Claude Code reads an Enter in the same burst as a line break).
import type { AgentStatus, DiffNoteData } from '../shared/workspace'

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

/** Paste the batch (bracketed paste keeps newlines from submitting) then submit with a separate Enter. */
export async function deliverNotes(
  write: (data: string) => void, text: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  write(`${PASTE_START}${text}${PASTE_END}`)
  await sleep(SUBMIT_GAP_MS)
  write('\r')
}
