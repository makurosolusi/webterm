// In-memory channel health (egress = Telegram sends, ingress = webhook dispatch). Pure: no I/O,
// no timers. Error text is redacted and truncated on the way in so a status reader can never see
// a token, whichever caller recorded it.
import { redactSecrets } from './webhookRedact'

/** Max stored length of a recorded error message, after redaction. */
export const CHANNEL_STATUS_MAX_ERROR_CHARS = 300

export interface ChannelDirectionStatus {
  lastOk?: number
  lastError?: { at: number; message: string }
  okCount: number
  errorCount: number
}

export interface ChannelStatus {
  egress: ChannelDirectionStatus
  ingress: ChannelDirectionStatus
}

export interface ChannelEvent {
  ok: boolean
  at: number
  error?: string
}

const empty = (): ChannelDirectionStatus => ({ okCount: 0, errorCount: 0 })
let state: ChannelStatus = { egress: empty(), ingress: empty() }

function record(dir: ChannelDirectionStatus, event: ChannelEvent): void {
  if (event.ok) {
    dir.okCount += 1
    dir.lastOk = event.at
    return
  }
  dir.errorCount += 1
  dir.lastError = {
    at: event.at,
    message: redactSecrets(event.error ?? 'unknown_error').slice(0, CHANNEL_STATUS_MAX_ERROR_CHARS),
  }
}

/** Record the outcome of one Telegram send attempt. */
export function recordEgress(event: ChannelEvent): void {
  record(state.egress, event)
}

/** Record the outcome of one inbound webhook dispatch. */
export function recordIngress(event: ChannelEvent): void {
  record(state.ingress, event)
}

/** Snapshot copy; mutating it does not affect the recorded status. */
export function getChannelStatus(): ChannelStatus {
  return structuredClone(state)
}

/** Test seam: clear all counters. */
export function resetChannelStatus(): void {
  state = { egress: empty(), ingress: empty() }
}
