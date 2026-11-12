// `POST /api/central/conversations/:id/regenerate` and `/edit` (central/chat/turnRerun.ts). Body
// `{clientMessageId, messageId}` (+ `text` for edit); answers 202 like a send, 409 while a turn runs,
// 404 for an unknown message and 400 `not_last_message` for any message but the last one.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readCappedRequestBody } from './cappedRequestBody'
import { MAX_MESSAGE_CHARS } from './central/conversationModel'
import type { RerunMode } from './central/chat/turnRerun'
import { type ChatService, failFromError, failJson, sendJson } from './centralChatHandlers'

/** The text (4 bytes per char at worst) plus the ids; attachments are resent by the server, never uploaded. */
const RERUN_BODY_MAX_BYTES = MAX_MESSAGE_CHARS * 4 + 4096

export async function handleRerun(
  req: IncomingMessage, res: ServerResponse, chat: ChatService, conversationId: string, mode: RerunMode,
): Promise<void> {
  const read = await readCappedRequestBody(req, RERUN_BODY_MAX_BYTES)
  if (!read.ok) {
    const tooLarge = read.reason === 'too_large'
    return sendJson(res, tooLarge ? 413 : 400, { error: { code: tooLarge ? 'payload_too_large' : 'invalid_body', message: read.reason } })
  }
  let body: unknown
  try { body = JSON.parse(read.body) } catch { body = null } // malformed JSON is the 400 below
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return failJson(res, 'invalid_body', `body must be {clientMessageId,messageId${mode === 'edit' ? ',text' : ''}}`)
  }
  const { clientMessageId, messageId, text } = body as Record<string, unknown>
  try {
    const result = chat.service.rerun({ conversationId, mode, clientMessageId, messageId, ...(mode === 'edit' ? { text } : {}) })
    sendJson(res, 202, result.response)
    void result.done.catch(() => undefined)
  } catch (err) {
    failFromError(res, err)
  }
}
