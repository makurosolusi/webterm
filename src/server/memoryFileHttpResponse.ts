// Response shaping for the memory-file HTTP surface: compact route results, one redacting
// failure mapper, and list caps. Kept out of `memoryFileHttp` so the route module stays small.
import { redactSecrets } from './channels/webhook'
import { MemoryAuthorityError, MemoryConflictError, MemoryError } from './memory/memoryModel'

export type RouteResult = { status: number; body: unknown }

const MAX_MESSAGE_CHARS = 300
const LIST_CAP = 20

function safeMessage(err: Error): string {
  // Same egress scrubber as the channel senders: git stderr can quote anything, tokens included.
  const message = redactSecrets(err.message.replace(/\s+/g, ' ').trim())
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message
}

export function failure(err: unknown): RouteResult {
  if (err instanceof MemoryAuthorityError) return { status: 403, body: { error: 'memory_forbidden' } }
  if (err instanceof MemoryConflictError) {
    return { status: 409, body: { error: 'memory_conflict', message: safeMessage(err) } }
  }
  if (err instanceof MemoryError) {
    return { status: 400, body: { error: 'memory_file_error', message: safeMessage(err) } }
  }
  // Never surface an unexpected error: messages can quote absolute paths.
  return { status: 500, body: { error: 'memory_file_internal' } }
}

export function capped<T>(items: T[]): { items: T[]; total: number } {
  return { items: items.slice(0, LIST_CAP), total: items.length }
}
