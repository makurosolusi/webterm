/**
 * Server-side attestation of user quotes (invariant I4, decision P5): central may store a `user`
 * fact only if its `quote` is a verbatim substring of a REAL human message in the conversation
 * the server is serving. The conversation id comes from the server, never from the tool input.
 */
import type { Database } from 'bun:sqlite'
import { allRows } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import { MemoryRejectedError } from './memoryModel'

export const MIN_QUOTE_CHARS = 8
export const MAX_QUOTE_CHARS = 300
/** Newest human messages scanned per attestation (Rule 13: bounded). */
export const ATTEST_SCAN_MESSAGES = 200
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface Attestation {
  messageId: string
}

function humanTexts(partsJson: string): string[] {
  try {
    const parts: unknown = JSON.parse(partsJson)
    if (!Array.isArray(parts)) return []
    return parts.flatMap((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : []
    )
  } catch {
    // A corrupt parts row cannot attest anything; skip it rather than fail the whole scan.
    return []
  }
}

/**
 * Returns the message that contains `quote` verbatim (exact, case-sensitive, no normalisation) or
 * throws `MemoryRejectedError`. Only `role='human'` text parts count: assistant, tool and system
 * messages cannot attest, so central cannot launder its own words through the transcript.
 */
export function attestUserQuote(db: Database, conversationId: string, quote: unknown): Attestation {
  if (typeof quote !== 'string') throw new MemoryRejectedError('invalid_quote', 'quote must be a string')
  if (quote.trim().length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) {
    throw new MemoryRejectedError('invalid_quote', `quote must be ${MIN_QUOTE_CHARS}-${MAX_QUOTE_CHARS} characters`)
  }
  if (CONTROL_CHARS.test(quote)) throw new MemoryRejectedError('invalid_quote', 'quote contains control characters')
  if (redactSecrets(quote) !== quote) throw new MemoryRejectedError('secret_detected', 'quote looks like a credential')
  const rows = allRows(
    db,
    `SELECT id, parts_json FROM central_message
     WHERE conversation_id = ? AND role = 'human' ORDER BY seq DESC LIMIT ?`,
    conversationId, ATTEST_SCAN_MESSAGES
  )
  for (const row of rows) {
    if (humanTexts(String(row['parts_json'])).some((text) => text.includes(quote))) {
      return { messageId: String(row['id']) }
    }
  }
  throw new MemoryRejectedError('quote_not_verbatim', 'quote is not a verbatim part of a human message in this conversation')
}
