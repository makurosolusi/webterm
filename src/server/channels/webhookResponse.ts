// HTTP shape for a webhook verification result.
import type { WebhookVerification } from './webhookTypes'

export interface WebhookHttpResponse {
  status: number
  body: { ok: boolean; error?: string }
}

/**
 * HTTP shape for a webhook result. 200 means "durably accepted, no reply"; 202 means
 * "accepted, reply follows". Auth/size failures map to their status with no detail leak.
 */
export function webhookResponse(
  verification: WebhookVerification,
  acceptedStatus: 200 | 202 = 200
): WebhookHttpResponse {
  if (verification.ok) return { status: acceptedStatus, body: { ok: true } }
  return { status: verification.status, body: { ok: false, error: verification.reason } }
}
