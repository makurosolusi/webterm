import { redactSecrets } from './webhook'

const DEFAULT_MAX_CHARS = 200

/**
 * Error text safe for logs or chat replies: channel errors can embed a bot token from a URL, so
 * scrub, then truncate. `fallback` stands in when the thrown value is neither Error nor string.
 */
export function safeErrorText(err: unknown, fallback: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback
  return redactSecrets(text).slice(0, maxChars)
}
