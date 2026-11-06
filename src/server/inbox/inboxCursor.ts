// Keyset cursor for the open inbox list (agent-211-C8). The list is ordered by (kind rank,
// created_at, id); the cursor is the last row's key, opaque (base64url JSON) to the client.

/** Kind order of the inbox: gates first, then questions, reviews, and everything else. */
export const INBOX_KIND_ORDER = ['gate', 'question', 'review'] as const
/** SQL rank of `i.kind`, matching INBOX_KIND_ORDER. */
export const INBOX_KIND_RANK = `CASE i.kind ${INBOX_KIND_ORDER.map((k, n) => `WHEN '${k}' THEN ${n}`).join(' ')} ELSE ${INBOX_KIND_ORDER.length} END`

export interface InboxCursor {
  rank: number
  createdAt: number
  id: string
}

export class InboxCursorError extends Error {}

export const kindRank = (kind: string): number => {
  const n = (INBOX_KIND_ORDER as readonly string[]).indexOf(kind)
  return n === -1 ? INBOX_KIND_ORDER.length : n
}

export function encodeInboxCursor(c: InboxCursor): string {
  return Buffer.from(JSON.stringify([c.rank, c.createdAt, c.id])).toString('base64url')
}

/** Throws InboxCursorError on anything that is not a cursor this server produced. */
export function decodeInboxCursor(raw: string): InboxCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch (err) {
    throw new InboxCursorError('inbox cursor is not valid base64url JSON', { cause: err })
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new InboxCursorError('inbox cursor has the wrong shape')
  const [rank, createdAt, id] = parsed as unknown[]
  if (!Number.isSafeInteger(rank) || !Number.isSafeInteger(createdAt) || typeof id !== 'string' || id === '') {
    throw new InboxCursorError('inbox cursor has the wrong field types')
  }
  return { rank: rank as number, createdAt: createdAt as number, id }
}
