// Appends a notice to a Central conversation outside any turn (a gate waiting, an agent that needs
// input). It is a `system` message with one `notice` part, published as `message.created` on the
// same stream hub the chat SSE reads, so an open Central chat shows it live and history keeps it.
// Telegram mirrors these notices (channels/channelNotices.ts): one source for both surfaces.
import type { Database } from 'bun:sqlite'
import { resolveChatService } from '../../centralChatHandlers'
import { GLOBAL_CONVERSATION_ID } from '../conversationModel'
import { centralRuntimeKind } from '../runtime/runtimeFlag'
import type { RuntimeKind } from '../runtime/centralRuntime'
import { getOrCreateConversation, appendMessage } from '../conversationStore'
import { recordEvent } from './turnPersistence'

/** A `notice` part is one line of at most 200 chars (conversationModel `partText`). */
const NOTICE_MAX = 200

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > NOTICE_MAX ? `${flat.slice(0, NOTICE_MAX - 1)}…` : flat
}

export interface CentralNoticeInput {
  /** Idempotency key (stored as the message's client id): the same key never adds a second notice. */
  key: string
  text: string
  /** Defaults to the UI's default conversation, `central:global`. */
  conversationId?: string
  /** Runtime whose stream hub the chat SSE uses; defaults to `WEBTERM_CENTRAL_RUNTIME`. */
  kind?: RuntimeKind
  now?: () => number
}

/** Returns true when the notice was new (and published); false for a repeated key. */
export function appendCentralNotice(db: Database, input: CentralNoticeInput): boolean {
  const now = input.now ?? Date.now
  const conversationId = input.conversationId ?? GLOBAL_CONVERSATION_ID
  if (conversationId === GLOBAL_CONVERSATION_ID) getOrCreateConversation(db, 'global')
  const { message, created } = appendMessage(db, {
    conversationId, role: 'system', parts: [{ type: 'notice', text: oneLine(input.text) }],
    clientMessageId: `notice:${input.key}`, now: now(),
  })
  if (!created) return false
  const { stream } = resolveChatService({}, db, input.kind ?? centralRuntimeKind())
  recordEvent(db, stream, conversationId, 'message.created', {
    messageId: message.id, seq: message.seq, role: 'system', parts: message.parts, state: 'complete',
  }, null, message.id, now)
  return true
}
