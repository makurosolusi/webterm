// Which Central chat the panel shows. Pure: ChatPanel owns state; this only decides.
// Rule: the steward chat (mode null) is the default everywhere; a skill-author chat is shown only when opened explicitly
// (Skills tab button, OS banner, History), never by fallback or by a remembered id from an earlier session.
import type { ChatConversation } from './chatTypes'
import { SKILL_AUTHOR_MODE } from './chatTypes'

type Row = Pick<ChatConversation, 'id' | 'mode'>

/** The newest steward chat; rows arrive newest first. */
export function latestSteward<T extends Row>(rows: readonly T[]): T | null {
  return rows.find((row) => row.mode !== SKILL_AUTHOR_MODE) ?? null
}

/** Id to show: `selected` if it still exists and is allowed (a skill-author chat only when `explicit`), else the newest steward chat, else null. */
export function resolveSelection(rows: readonly Row[], selected: string | null, explicit: boolean): string | null {
  const current = selected === null ? undefined : rows.find((row) => row.id === selected)
  if (current && (explicit || current.mode !== SKILL_AUTHOR_MODE)) return current.id
  return latestSteward(rows)?.id ?? null
}
