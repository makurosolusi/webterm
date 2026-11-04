// Web Push state: the VAPID key pair (secret store, generated once on first use) and one small JSON
// file for browser subscriptions + what was already pushed. The file holds per-device push secrets
// (`auth`), so it is written 0600 with temp+rename like the secret store; it is not in webterm.db
// (0644, backed up). The secret store caps a value at 4 KiB, too small for a list of devices.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { SecretStore } from '../envSecrets.store'
import { fromB64url, generateVapidKeys, jwkToPoint, b64url, type VapidKeys } from './webPush.crypto'

export const VAPID_SECRET_KEY = 'WEBPUSH_VAPID_JWK'
export const PUSH_STATE_FILE = 'push-subscriptions.json'
/** One person's phones/tablets/browsers; more is a bug or abuse. */
export const MAX_SUBSCRIPTIONS = 20
const ENDPOINT_MAX = 1024
/** Sent-id memory: open items only, so it stays at the inbox list size. */
const SENT_MAX = 500
/**
 * The server POSTs to whatever endpoint a browser hands it, so only real push services are allowed
 * (Chrome/Edge FCM, Firefox autopush, Safari/iOS APNs web push, Windows WNS). Any other host would
 * turn subscribe into a server-side request to an arbitrary URL.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/]

export interface PushSubscriptionRecord { endpoint: string; p256dh: string; auth: string; createdAt: number }
export interface PushState { subs: PushSubscriptionRecord[]; sent: string[]; briefDay: string | null }

export const pushStatePath = (dataDir: string): string => join(dataDir, PUSH_STATE_FILE)

export function readPushState(path: string): PushState {
  if (!existsSync(path)) return { subs: [], sent: [], briefDay: null }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (err) {
    throw new Error(`push store: cannot read ${PUSH_STATE_FILE} (${err instanceof Error ? err.message : String(err)})`)
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PushState>
  return {
    subs: Array.isArray(r.subs) ? r.subs.filter((s) => parseSubscription(s) !== null) : [],
    sent: Array.isArray(r.sent) ? r.sent.filter((s): s is string => typeof s === 'string').slice(-SENT_MAX) : [],
    briefDay: typeof r.briefDay === 'string' ? r.briefDay : null,
  }
}

export function writePushState(path: string, state: PushState): void {
  const tmp = join(dirname(path), `.${PUSH_STATE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify({ ...state, sent: state.sent.slice(-SENT_MAX) }), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* tmp never created: nothing to clean */ }
    throw new Error(`push store: write failed (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
  }
}

const b64Len = (v: unknown, bytes: number): v is string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(v)) return false
  return fromB64url(v).length === bytes
}

/** `PushSubscription.toJSON()` shape (or a stored record) -> record; null = refuse. */
export function parseSubscription(raw: unknown, now = Date.now()): PushSubscriptionRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; p256dh?: unknown; auth?: unknown; createdAt?: unknown }
  if (typeof r.endpoint !== 'string' || r.endpoint.length > ENDPOINT_MAX) return null
  let url: URL
  try { url = new URL(r.endpoint) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null
  const p256dh = r.keys?.p256dh ?? r.p256dh
  const auth = r.keys?.auth ?? r.auth
  if (!b64Len(p256dh, 65) || !b64Len(auth, 16)) return null
  return { endpoint: r.endpoint, p256dh, auth, createdAt: typeof r.createdAt === 'number' ? r.createdAt : now }
}

/** Adds or refreshes (same endpoint) a subscription; oldest dropped past the cap. */
export function upsertSubscription(state: PushState, sub: PushSubscriptionRecord): PushState {
  const subs = [...state.subs.filter((s) => s.endpoint !== sub.endpoint), sub].slice(-MAX_SUBSCRIPTIONS)
  return { ...state, subs }
}

export function removeSubscription(state: PushState, endpoint: string): PushState {
  return { ...state, subs: state.subs.filter((s) => s.endpoint !== endpoint) }
}

let pending: Promise<VapidKeys> | null = null

/** The server's VAPID keys, generated and stored on first call (one in-flight generation per process). */
export function vapidKeys(store: SecretStore): Promise<VapidKeys> {
  const stored = store.read(VAPID_SECRET_KEY)
  if (stored) {
    let jwk: JsonWebKey
    try { jwk = JSON.parse(stored) as JsonWebKey } catch { throw new Error(`push store: ${VAPID_SECRET_KEY} is not valid JSON`) }
    return Promise.resolve({ privateJwk: jwk, publicKey: b64url(jwkToPoint(jwk)) })
  }
  pending ??= generateVapidKeys().then((keys) => {
    store.write(VAPID_SECRET_KEY, JSON.stringify(keys.privateJwk))
    return keys
  }).finally(() => { pending = null })
  return pending
}
