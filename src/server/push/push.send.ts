// Payload + delivery of one Web Push message. The payload is deliberately thin: an id, a kind and
// a redacted title, plus where a tap goes. No args, bodies, impact or command output: a lock screen
// is not the place for them, and the phone fetches the details over the token-gated API anyway.
import { createLogger } from '../logs'
import { redactSecrets } from '../redactSecrets'
import type { PushSubscriptionRecord } from './push.store'
import { encryptPayload, fromB64url, vapidAuthorization, type VapidKeys } from './webPush.crypto'

const log = createLogger('push')
const TITLE_MAX = 120
/** A gate that waited a day is stale; the push service drops it rather than waking a phone late. */
const TTL_SEC = 24 * 3600
/** RFC 8292 `sub`: a contact for the push service operator. Apple refuses `localhost` addresses. */
export const VAPID_SUBJECT = 'mailto:webterm@example.com'
export const MOBILE_URL = '/m/'

export type PushKind = 'gate' | 'question' | 'review' | 'notify' | 'agent' | 'brief' | 'test'
export interface PushPayload { id: string; kind: PushKind; title: string; url: string }

const SCREEN: Record<PushKind, string> = { gate: 'inbox', question: 'inbox', review: 'inbox', notify: 'inbox', agent: 'agents', brief: 'brief', test: 'inbox' }

/** The only constructor of a payload: fixed fields, title flattened, clipped and redacted. */
export function buildPayload(id: string, kind: PushKind, title: string): PushPayload {
  const flat = redactSecrets(title.replace(/\s+/g, ' ').trim())
  return { id, kind, title: flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat, url: `${MOBILE_URL}#${SCREEN[kind]}` }
}

export type SendOutcome = 'sent' | 'gone' | 'failed'

export interface SendOptions { fetch: typeof fetch; nowSec: number; urgency?: 'normal' | 'high' }

export async function sendPush(sub: PushSubscriptionRecord, payload: PushPayload, keys: VapidKeys, opts: SendOptions): Promise<SendOutcome> {
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), fromB64url(sub.p256dh), fromB64url(sub.auth))
  const host = new URL(sub.endpoint).hostname // the path is a per-device credential: never logged
  let res: Response
  try {
    res = await opts.fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, keys, VAPID_SUBJECT, opts.nowSec),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SEC),
        Urgency: opts.urgency ?? 'normal',
      },
      body: body as BodyInit,
    })
  } catch (err) {
    log.warn('push.send_failed', 'Web Push request failed', { host, cause: err instanceof Error ? err.message : String(err) })
    return 'failed'
  }
  // 404/410 = the browser dropped this subscription (RFC 8030 §7.3): forget it.
  if (res.status === 404 || res.status === 410) return 'gone'
  if (res.ok) return 'sent'
  log.warn('push.send_rejected', 'Push service refused a message', { host, status: res.status })
  return 'failed'
}
