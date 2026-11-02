// Generic channel ingress verification (O12/P3). Every channel webhook passes the same gate:
// body size cap FIRST, then signature/timestamp (replay window), then provider-specific auth.
// Nothing here writes state or calls the network, so the gate is testable without a server.
//
// Secrets are read from env at CALL time, never captured at module load, and never included in
// a returned value or an error string. `../redactSecrets` is the single egress scrubber.
//
// This file is a barrel: the implementation lives in the sibling `webhook*.ts` modules.
export { MAX_WEBHOOK_BODY_BYTES, SIGNATURE_HEADER, TELEGRAM_SECRET_HEADER, TIMESTAMP_HEADER, bodyWithinLimit, headerValue } from './webhookGate'
export { DEFAULT_AUTH_FAILURE_LIMIT, DEFAULT_AUTH_FAILURE_WINDOW_MS, AttemptThrottle } from './webhookThrottle'
export { REPLAY_WINDOW_SECONDS, signWebhook, verifyWebhook, type VerifyWebhookInput } from './webhookSignature'
export {
  MAX_TELEGRAM_SECRET_LENGTH,
  MIN_TELEGRAM_SECRET_LENGTH,
  telegramSecretProblem,
  verifyTelegramSecret,
  type TelegramSecretOptions,
} from './webhookTelegram'
export { webhookResponse, type WebhookHttpResponse } from './webhookResponse'
export type { WebhookHeaders, WebhookRejectStatus, WebhookVerification } from './webhookTypes'
