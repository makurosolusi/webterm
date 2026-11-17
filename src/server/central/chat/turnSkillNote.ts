// "[webterm] Skills changed: ..." for a Central turn: the model-facing line plus the same text as a visible system notice
// (conversation history keeps it, like every other notice). The window logic lives in skills/skillToggleAudit.
import type { Database } from 'bun:sqlite'
import { appendMessage } from '../conversationStore'
import { skillsChangedNote } from '../skills/skillToggleAudit'

/** A `notice` part is one line of at most 200 chars (conversationModel `partText`). */
const NOTICE_MAX = 200

export interface SkillNote { text: string; message: ReturnType<typeof appendMessage>['message'] | null }

/** Null when no central skill was switched since this conversation's previous turn. */
export function skillNoteForTurn(db: Database, conversationId: string, clientMessageId: string, now: () => number): SkillNote | null {
  const text = skillsChangedNote({ db, now }, conversationId)
  if (!text) return null
  const shown = text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text
  const appended = appendMessage(db, { conversationId, role: 'system', parts: [{ type: 'notice', text: shown }], clientMessageId: `skills-changed:${clientMessageId}`, now: now() })
  return { text, message: appended.created ? appended.message : null }
}
