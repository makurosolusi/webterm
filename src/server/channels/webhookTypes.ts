// Shared result/input types for generic channel ingress verification (O12/P3).
// Types only: no behavior, no crypto, no env access.

export type WebhookHeaders = Record<string, string | string[] | undefined>
export type WebhookRejectStatus = 401 | 413

export type WebhookVerification =
  | { ok: true; timestamp: number }
  | { ok: false; status: WebhookRejectStatus; reason: string }
