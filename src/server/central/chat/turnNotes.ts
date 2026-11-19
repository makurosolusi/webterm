// Notes a Central turn starts with: `[webterm] Skills changed` (steward chats only) and `[webterm] Capabilities updated`
// (every chat, by its mode's registry profile). Each is the model-facing text plus the same line as a visible system notice.
import type { Database } from 'bun:sqlite'
import type { CapabilityId, ProfileId } from '../../../shared/agentCapabilities'
import { capabilityNote } from '../../capabilityNote'
import { stewardOffAbilities, currentTools } from '../context/capabilityMap'
import { appendMessage } from '../conversationStore'
import type { Conversation } from '../conversationStore'
import { skillNoteForTurn, type SkillNote } from './turnSkillNote'

/** A `notice` part is one line of at most 200 chars (conversationModel `partText`). */
const NOTICE_MAX = 200

type Notice = NonNullable<SkillNote['message']>
export interface TurnNotes { text: string | null; messages: Notice[] }

/** Registry profile of a conversation plus the abilities switched off right now; undefined = nothing to compare this turn. */
export function profileOf(c: Pick<Conversation, 'mode'>): { profile: ProfileId; off: Set<CapabilityId> } | undefined {
  if (c.mode !== null) return { profile: 'central.skill-author', off: new Set() }
  const tools = currentTools()
  // No catalog (Central not armed or the read failed) is not "everything off": skip rather than announce a false change.
  return tools.length ? { profile: 'central.steward', off: stewardOffAbilities(tools) } : undefined
}

/** The capability note of this turn (and its system notice), or null; records the briefing hash this conversation now has. */
function capabilityNoteForTurn(db: Database, c: Conversation, clientMessageId: string, now: () => number): { text: string; message: Notice | null } | null {
  const p = profileOf(c)
  const note = p && capabilityNote({ db, now }, `central:${c.id}`, p.profile, p.off)
  if (!note) return null
  const shown = note.line.length > NOTICE_MAX ? `${note.line.slice(0, NOTICE_MAX - 1)}…` : note.line
  const appended = appendMessage(db, { conversationId: c.id, role: 'system', parts: [{ type: 'notice', text: shown }], clientMessageId: `capabilities-updated:${clientMessageId}`, now: now() })
  return { text: note.text, message: appended.created ? appended.message : null }
}

export function turnNotes(db: Database, c: Conversation, clientMessageId: string, now: () => number): TurnNotes {
  const skill = c.mode === null ? skillNoteForTurn(db, c.id, clientMessageId, now) : null
  const cap = capabilityNoteForTurn(db, c, clientMessageId, now)
  const notices = [skill, cap].filter((n): n is NonNullable<typeof n> => n !== null)
  return { text: notices.length ? notices.map((n) => n.text).join('\n\n') : null, messages: notices.flatMap((n) => (n.message ? [n.message] : [])) }
}
