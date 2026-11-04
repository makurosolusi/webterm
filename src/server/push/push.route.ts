// HTTP for the /m PWA. Root token (outer gate in index.ts) and, for push, the UI-only rule
// (`uiOnlyDenial`: no agent credential, same-origin browser fetch), so an agent shell cannot
// subscribe its own endpoint or read the device list:
//   GET  /api/push                 -> { publicKey, subscriptions }
//   POST /api/push/subscribe   { subscription: PushSubscription.toJSON() } -> { subscriptions }
//   POST /api/push/unsubscribe { endpoint }                                 -> { subscriptions }
//   POST /api/push/test                                                     -> { sent }
//   GET  /api/mobile/agents        -> { agents: MobileAgent[] }
import type { IncomingMessage } from 'node:http'
import type { RouteResult } from '../apiShared.types'
import { uiOnlyDenial } from '../approvalAuth'
import { BodyReadError } from '../cappedRequestBody'
import { buildPayload } from './push.send'
import { parseSubscription, readPushState, removeSubscription, upsertSubscription, writePushState } from './push.store'
import { fanOut, type WebPushDeps } from './push.sweep'

export const PUSH_PATH = '/api/push'
export const MOBILE_AGENTS_PATH = '/api/mobile/agents'
export const PUSH_BODY_MAX_BYTES = 4 * 1024

export interface PushRouteDeps {
  push: Pick<WebPushDeps, 'statePath' | 'keys' | 'fetch' | 'now'>
  isNodeToken(token: string): boolean
}

const bad = (error: string): RouteResult => ({ status: 400, body: { error } })

async function readJson(body: () => Promise<string>): Promise<Record<string, unknown> | RouteResult> {
  let raw: string
  try { raw = await body() } catch (err) {
    if (err instanceof BodyReadError) return err.reason === 'too_large' ? { status: 413, body: { error: 'payload_too_large' } } : bad('body_read_failed')
    throw err
  }
  try {
    const v: unknown = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad('bad_json')
  } catch { return bad('bad_json') }
}
const isResult = (v: unknown): v is RouteResult => !!v && typeof v === 'object' && 'status' in v && 'body' in v

/** null = not a push path. */
export async function pushRoute(req: IncomingMessage, url: URL, method: string, body: () => Promise<string>, deps: PushRouteDeps): Promise<RouteResult | null> {
  const path = url.pathname
  if (path !== PUSH_PATH && !path.startsWith(`${PUSH_PATH}/`)) return null
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial } }
  const { statePath } = deps.push
  if (path === PUSH_PATH) {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: { publicKey: (await deps.push.keys()).publicKey, subscriptions: readPushState(statePath).subs.length } }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const action = path.slice(PUSH_PATH.length + 1)
  if (action === 'test') {
    const state = readPushState(statePath)
    if (state.subs.length === 0) return { status: 409, body: { error: 'no_subscriptions' } }
    const r = await fanOut({ ...deps.push, items: () => null, attention: { watching: () => false, muted: () => false }, awayMs: () => 0 },
      state, buildPayload(`test:${deps.push.now()}`, 'test', 'Test notification from webterm'), 'normal')
    if (r.state.subs.length !== state.subs.length) writePushState(statePath, r.state)
    return { status: 200, body: { sent: r.sent } }
  }
  if (action !== 'subscribe' && action !== 'unsubscribe') return { status: 404, body: { error: 'unknown route' } }
  const input = await readJson(body)
  if (isResult(input)) return input
  const state = readPushState(statePath)
  if (action === 'subscribe') {
    const sub = parseSubscription(input.subscription, deps.push.now())
    if (!sub) return bad('invalid_subscription')
    const next = upsertSubscription(state, sub)
    writePushState(statePath, next)
    return { status: 200, body: { subscriptions: next.subs.length } }
  }
  if (typeof input.endpoint !== 'string') return bad('invalid_endpoint')
  const next = removeSubscription(state, input.endpoint)
  writePushState(statePath, next)
  return { status: 200, body: { subscriptions: next.subs.length } }
}
