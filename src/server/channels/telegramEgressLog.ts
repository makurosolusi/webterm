// Egress observability: one redacted log line + one status record per send outcome. Metadata only
// (reply key, masked chat, text length, status codes); message text is never logged (PII).
import { recordEgress } from './channelStatus'
import { redactSecrets } from './webhookRedact'

/** Keep only the last 4 chars of a chat id so lines correlate without exposing the full id. */
export function maskChatId(chatId: string): string {
  return chatId.length <= 4 ? '***' : `***${chatId.slice(-4)}`
}

export interface EgressLogFields {
  key: string
  chatId: string
  textLength: number
  attempt: number
  status?: number
  errorCode?: number
}

function line(fields: EgressLogFields): string {
  const parts = [
    `key=${fields.key}`,
    `chat=${maskChatId(fields.chatId)}`,
    `len=${fields.textLength}`,
    `attempt=${fields.attempt}`,
  ]
  if (fields.status !== undefined) parts.push(`http=${fields.status}`)
  if (fields.errorCode !== undefined) parts.push(`code=${fields.errorCode}`)
  return parts.join(' ')
}

/** Log + record a successful send. */
export function logEgressSent(fields: EgressLogFields, at: number): void {
  console.info(`telegram egress sent ${line(fields)}`)
  recordEgress({ ok: true, at })
}

/** Log + record a failed send; `final` (dead-lettered) logs at error, a retry at warn. */
export function logEgressFailed(
  fields: EgressLogFields,
  at: number,
  error: string,
  outcome: 'retry' | 'dead'
): void {
  const safe = redactSecrets(error).slice(0, 300)
  const log = outcome === 'dead' ? console.error : console.warn
  log(`telegram egress ${outcome} ${line(fields)} error=${safe}`)
  recordEgress({ ok: false, at, error: safe })
}

/** Log + record an unexpected sender-side failure (store port threw, tick rejected). */
export function logEgressInternal(operation: string, err: unknown, at: number): void {
  const message = redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300)
  console.error(`telegram egress ${operation} failed: ${message}`)
  recordEgress({ ok: false, at, error: `${operation}: ${message}` })
}
