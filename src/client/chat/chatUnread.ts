// Unread per Central conversation: a conversation is unread when the server's `lastMessageSeq` is past the
// seq the user last saw (`seenSeq`, persisted per id) and it is not the one being watched right now.
// Pure helpers only; the live list and polling are `./chatFeed`.
import type { ChatConversation } from './chatTypes'

const SEEN_KEY = 'webterm.chatSeenSeq'

export type SeenMap = Record<string, number>

/** Persisted seenSeq per conversation id; empty when storage is unavailable (render stays correct). */
export function readSeen(): SeenMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: SeenMap = {}
    for (const [id, seq] of Object.entries(parsed)) if (typeof seq === 'number') out[id] = seq
    return out
  } catch {
    return {}
  }
}

export function writeSeen(seen: SeenMap): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // Private mode: unread state lasts for this tab only.
  }
}

/** Ids with messages past `seen` that the user is not watching (`isWatching`). */
export function unreadIds(
  rows: readonly ChatConversation[],
  seen: Readonly<SeenMap>,
  isWatching: (id: string) => boolean
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const row of rows) if (row.lastMessageSeq > (seen[row.id] ?? 0) && !isWatching(row.id)) out.add(row.id)
  return out
}
