// Web Push from the /m PWA: can this browser do it, and subscribe/unsubscribe against
// `/api/push` (server keeps the VAPID key and the device list). iOS only delivers Web Push to a
// PWA added to the Home Screen (iOS 16.4+), so a Safari tab gets instructions instead of a button.
import { request } from '../inboxTransport'

export const PUSH_API = '/api/push'
export const SW_URL = '/m/sw.js'
export const SW_SCOPE = '/m/'

export type PushSupport = 'ok' | 'insecure' | 'ios-install' | 'unsupported'

export interface PushEnv {
  isSecureContext: boolean
  userAgent: string
  maxTouchPoints: number
  standalone: boolean
  hasPushManager: boolean
  hasServiceWorker: boolean
  hasNotification: boolean
}

export function browserPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean }
  return {
    isSecureContext: window.isSecureContext,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
    hasPushManager: 'PushManager' in window,
    hasServiceWorker: 'serviceWorker' in nav,
    hasNotification: 'Notification' in window,
  }
}

/** iPhone/iPad, including iPadOS that reports itself as a Mac. */
export function isIos(env: Pick<PushEnv, 'userAgent' | 'maxTouchPoints'>): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)
}

export function pushSupport(env: PushEnv): PushSupport {
  if (!env.isSecureContext) return 'insecure'
  if (isIos(env) && !env.standalone) return 'ios-install'
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported'
  return 'ok'
}

export const SUPPORT_TEXT: Record<Exclude<PushSupport, 'ok'>, string> = {
  insecure: 'Notifications need HTTPS. Open webterm over an https:// address (for example a Tailscale or Cloudflare tunnel) to turn them on.',
  'ios-install': 'On iPhone and iPad, notifications only work from the Home Screen app: tap Share, then "Add to Home Screen", and open webterm from there.',
  unsupported: 'This browser cannot receive web notifications.',
}

export function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration(SW_SCOPE)) ?? navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await registration()).pushManager.getSubscription()
}

/** Must run from a tap (iOS refuses a permission prompt without a user gesture). */
export async function enablePush(): Promise<'granted' | 'denied'> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  const { publicKey } = await request<{ publicKey: string }>(PUSH_API)
  const reg = await registration()
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) }))
  await post(`${PUSH_API}/subscribe`, { subscription: sub.toJSON() })
  return 'granted'
}

/** Re-sends an existing browser subscription (idempotent), so a server reset relearns this device. */
export async function syncPush(): Promise<boolean> {
  const sub = await currentSubscription()
  if (!sub) return false
  await post(`${PUSH_API}/subscribe`, { subscription: sub.toJSON() })
  return true
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await post(`${PUSH_API}/unsubscribe`, { endpoint: sub.endpoint })
  await sub.unsubscribe()
}

export const sendTestPush = () => post<{ sent: number }>(`${PUSH_API}/test`)
