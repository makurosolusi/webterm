// SSE handler for one chat conversation (RND/08 §7, RND/13 §4 C1).
// Replays `central_event` from `Last-Event-ID`/`?after`, then streams live frames
// from the shared hub; heartbeat + disconnect cleanup live in `streamHub`.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import { getConversation } from './central/conversationStore'
import { formatSseFrame } from './central/chat/streamHub'
import { failJson, nonNegativeInteger, type ChatService } from './centralChatHandlers'
import { firstHeader } from './httpHeaders'

export function handleStream(
  req: IncomingMessage, res: ServerResponse, url: URL, conversationId: string,
  db: Database, chat: ChatService
): void {
  let exists = false
  try {
    exists = getConversation(db, conversationId) !== null
  } catch {
    // A non-canonical id is simply not a conversation this surface owns.
    exists = false
  }
  if (!exists) {
    failJson(res, 'conversation_not_found', 'conversation not found')
    return
  }
  const header = req.headers['last-event-id']
  const rawCursor = firstHeader(header)
  const cursor = rawCursor === undefined
    ? nonNegativeInteger(url.searchParams.get('after'))
    : nonNegativeInteger(rawCursor)
  if (cursor === null) {
    failJson(res, 'invalid_cursor', 'Last-Event-ID must be a non-negative integer')
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()
  const unsubscribe = chat.stream.subscribe(conversationId, cursor ?? 0, (frame) => {
    if (!res.writableEnded) res.write(formatSseFrame(frame))
  })
  const cleanup = (): void => unsubscribe()
  res.on('close', cleanup)
  req.on('close', cleanup)
}
