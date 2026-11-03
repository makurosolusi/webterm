import type { Database } from 'bun:sqlite'
import { createLogger } from '../../logs'
import { buildMemoryBlock, CHARS_PER_TOKEN, MEMORY_BLOCK_MAX_TOKENS } from '../../memory/memoryBlock'

export interface MemoryContextOptions {
  limit?: number
  maxChars?: number
  now?: () => number
}

const DEFAULT_LIMIT = 6
const MAX_LIMIT = 10
const log = createLogger('memory')

/**
 * Bounded, read-only memory block for the central prompt. Delegates to the v2 hybrid block, so the
 * global conversation (B4) now gets user/global/central memory too. Never throws: '' on any failure.
 */
export function buildMemoryContext(
  db: Database,
  conversationId: string,
  query: string,
  options: MemoryContextOptions = {}
): string {
  try {
    const limit = Math.min(Math.max(0, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
    const maxChars = options.maxChars === undefined ? MEMORY_BLOCK_MAX_TOKENS * CHARS_PER_TOKEN : Math.max(0, Math.floor(options.maxChars))
    if (limit === 0 || maxChars === 0) return ''
    const block = buildMemoryBlock(db, { conversationId, projectId: null, query, maxTokens: Math.floor(maxChars / CHARS_PER_TOKEN) },
      { limit, ...(options.now ? { now: options.now } : {}) })
    return block.text.length <= maxChars ? block.text : ''
  } catch (err) {
    log.warn('memory.context.failed', 'memory context unavailable; continuing without it', { error: err instanceof Error ? err.message : String(err) })
    return ''
  }
}
