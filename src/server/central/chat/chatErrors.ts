// Stable chat error taxonomy shared by the turn service and the HTTP seam
// (RND/08 §7, RND/13 §4 C1). Codes are contract; messages are diagnostics.
export type ChatErrorCode =
  | 'central_runtime_off' | 'conversation_busy' | 'conversation_not_found' | 'turn_not_found'
  | 'turn_not_active' | 'invalid_message' | 'invalid_limit' | 'invalid_body' | 'invalid_cursor'

export class CentralChatError extends Error {
  constructor(readonly code: ChatErrorCode, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = 'CentralChatError'
  }
}

/** Status mapping shared with the HTTP seam so the wire contract stays one place. */
export function chatErrorStatus(code: string): number {
  if (code === 'central_runtime_off') return 503
  if (code === 'conversation_busy' || code === 'turn_not_active') return 409
  if (code === 'conversation_not_found' || code === 'turn_not_found') return 404
  if (code === 'invalid_limit' || code === 'invalid_cursor') return 400
  return 400
}
