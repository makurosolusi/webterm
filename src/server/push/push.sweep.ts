// Web Push to the /m PWA, under the same attention policy as the Telegram cards (inbox/inboxAttention):
//  - inbox items (gates, questions, reviews, the daily digest) via a sweep, like `sweepInboxPush`;
//  - "agent needs input" on a `hook.*` status transition to `waiting`, like the Telegram forwarder;
//  - "morning brief ready" once per local day after the user has been away a while.
// Nothing goes out while the desktop tab is on that node (`watchingFrom`). The Telegram sweep's
// `pushed_at` column is Telegram's: web push keeps its own sent-id list (push.store), pruned to the
// items still open, so a snoozed item that resurfaces is pushed again, exactly like Telegram.
import type { SenseEvent } from '../events/eventModel'
import type { InboxEntry } from '../inbox/inboxItemModel'
import { attentionFor, type AttentionContext } from '../inbox/inboxAttention'
import { createLogger } from '../logs'
import { buildPayload, sendPush, type PushKind, type PushPayload, type SendResult } from './push.send'
import { readPushState, writePushState, type PushRetry, type PushState } from './push.store'
import type { VapidKeys } from './webPush.crypto'

const log = createLogger('push')
export const WEB_PUSH_INTERVAL_MS = 3000
/** Same "you were away" gap the brief uses to open a new visit (brief.service AWAY_GAP_MS). */
export const BRIEF_AWAY_MS = 30 * 60_000
/** No "brief ready" ping in the small hours. */
export const BRIEF_EARLIEST_HOUR = 7
const BRIEF_RECHECK_MS = 10 * 60_000
/** Delivery attempts for one item while every device fails, then it is given up (telegramSender pattern). */
export const WEB_PUSH_MAX_ATTEMPTS = 5
export const WEB_PUSH_RETRY_BASE_MS = 30_000
export const WEB_PUSH_RETRY_MAX_MS = 30 * 60_000

export interface WebPushDeps {
  statePath: string
  keys(): Promise<VapidKeys>
  fetch: typeof fetch
  now(): number
  /** Open inbox items; null = ledger off. */
  items(): InboxEntry[] | null
  attention: AttentionContext
  awayMs(): number
  /** Plain-text brief (`renderBriefText`); optional so tests can leave it out. */
  briefText?(): Promise<string>
}

const localDay = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface FanOutResult {
  state: PushState
  sent: number
  failed: number
  /** First failure's host + status/cause; never the endpoint path. */
  reason?: string
  /** Longest `Retry-After` any push service asked for. */
  retryAfterMs?: number
}

/** Sends one payload to every subscription; drops the ones the push service says are gone. Never logs. */
export async function fanOut(deps: WebPushDeps, state: PushState, payload: PushPayload, urgency: 'normal' | 'high'): Promise<FanOutResult> {
  if (state.subs.length === 0) return { state, sent: 0, failed: 0 }
  const keys = await deps.keys()
  const results: SendResult[] = []
  for (const sub of state.subs) results.push(await sendPush(sub, payload, keys, { fetch: deps.fetch, nowSec: Math.floor(deps.now() / 1000), urgency }))
  const subs = state.subs.filter((_, i) => results[i]!.outcome !== 'gone')
  const failures = results.filter((r) => r.outcome === 'failed')
  const waits = failures.map((r) => r.retryAfterMs).filter((ms): ms is number => ms !== undefined)
  return {
    state: { ...state, subs },
    sent: results.filter((r) => r.outcome === 'sent').length,
    failed: failures.length,
    ...(failures[0]?.reason === undefined ? {} : { reason: failures[0].reason }),
    ...(waits.length === 0 ? {} : { retryAfterMs: Math.max(...waits) }),
  }
}

/**
 * Next retry record after every device failed for `itemId`. Logs only on a state change: the first
 * failure and the give-up, never once per attempt.
 */
function recordFailure(itemId: string, prev: PushRetry | undefined, r: FanOutResult, now: number): PushRetry {
  const attempts = (prev?.attempts ?? 0) + 1
  const fields = { itemId, attempts, reason: r.reason }
  if (attempts >= WEB_PUSH_MAX_ATTEMPTS) {
    log.error('push.gave_up', `Web Push gave up on an item after ${attempts} attempts`, fields)
    return { attempts, nextAt: now, gaveUp: true }
  }
  const delay = Math.max(r.retryAfterMs ?? 0, Math.min(WEB_PUSH_RETRY_MAX_MS, WEB_PUSH_RETRY_BASE_MS * 2 ** (attempts - 1)))
  if (attempts === 1) log.warn('push.send_failed', `Web Push failed on every device; retrying with backoff`, { ...fields, retryInMs: delay })
  return { attempts, nextAt: now + delay }
}

let briefCheckedAt = -Infinity

/** One pass; returns the inbox ids pushed and held (for tests and logs). */
export async function sweepWebPush(deps: WebPushDeps): Promise<{ pushed: string[]; held: string[] }> {
  let state = readPushState(deps.statePath)
  if (state.subs.length === 0) return { pushed: [], held: [] } // nobody subscribed: do no work at all
  const before = JSON.stringify(state)
  const pushed: string[] = []
  const held: string[] = []
  const items = deps.items()
  if (items) {
    const open = new Set(items.map((i) => i.id))
    const sent = new Set(state.sent.filter((id) => open.has(id)))
    // Pruned to open items like `sent`, so a resurfacing item starts with a fresh budget.
    const retry = Object.fromEntries(Object.entries(state.retry ?? {}).filter(([id]) => open.has(id)))
    const now = deps.now()
    for (const item of items) {
      if (sent.has(item.id)) continue
      const verdict = attentionFor(item, deps.attention)
      if (verdict === 'hold') { held.push(item.id); continue }
      if (verdict === 'push') {
        const prev = retry[item.id]
        if (prev && (prev.gaveUp || prev.nextAt > now)) continue
        const r = await fanOut(deps, state, buildPayload(item.id, item.kind as PushKind, item.title), item.kind === 'gate' ? 'high' : 'normal')
        state = r.state
        if (r.sent === 0) {
          if (r.failed > 0) retry[item.id] = recordFailure(item.id, prev, r, now)
          continue // every device failed (or was gone): retry once the backoff allows
        }
        if (prev) log.info('push.recovered', 'Web Push delivered after earlier failures', { itemId: item.id, attempts: prev.attempts })
        delete retry[item.id]
        pushed.push(item.id)
      }
      sent.add(item.id)
    }
    state = { ...state, sent: [...sent], retry }
  }
  state = await maybeBrief(deps, state)
  if (JSON.stringify(state) !== before) writePushState(deps.statePath, state)
  return { pushed, held }
}

async function maybeBrief(deps: WebPushDeps, state: PushState): Promise<PushState> {
  const now = deps.now()
  const day = localDay(now)
  if (!deps.briefText || state.briefDay === day || new Date(now).getHours() < BRIEF_EARLIEST_HOUR) return state
  if (deps.awayMs() < BRIEF_AWAY_MS || now - briefCheckedAt < BRIEF_RECHECK_MS) return state
  briefCheckedAt = now
  const text = await deps.briefText()
  const lines = text.split('\n').filter((l) => l.startsWith('- ')).length
  if (lines === 0) return state
  const r = await fanOut(deps, state, buildPayload(`brief:${day}`, 'brief', `Morning brief ready: ${lines} update${lines === 1 ? '' : 's'}`), 'normal')
  return r.sent > 0 ? { ...r.state, briefDay: day } : r.state
}

/** Test hook: forget the brief throttle. */
export function resetBriefThrottle(): void { briefCheckedAt = -Infinity }

export interface HookPushDeps extends Pick<WebPushDeps, 'statePath' | 'keys' | 'fetch' | 'now' | 'attention'> {
  label(nodeId: string): string
}

/**
 * `hook.*` listener: a transition to `waiting` (Claude stopped and wants you) is pushed unless the
 * desktop tab is on that node or the workspace is muted. `blocked` is not pushed here: a permission
 * prompt is an inbox gate and the sweep sends it. Returns the listener (never throws into the bus).
 */
export function hookPushListener(deps: HookPushDeps): (event: SenseEvent) => void {
  const last = new Map<string, string>()
  return (event) => {
    const status = (event.payload as { status?: unknown } | null)?.status
    if (typeof status !== 'string' || !event.nodeId) return
    const prev = last.get(event.nodeId)
    last.set(event.nodeId, status)
    if (status !== 'waiting' || prev === status) return
    const probe = { kind: 'question' as const, source: 'agent', nodeId: event.nodeId, workspaceId: event.workspaceId ?? null }
    if (attentionFor(probe, deps.attention) !== 'push') return
    const nodeId = event.nodeId
    void (async () => {
      const state = readPushState(deps.statePath)
      if (state.subs.length === 0) return
      const r = await fanOut({ ...deps, items: () => null, awayMs: () => 0 }, state, buildPayload(`agent:${nodeId}:${event.seq}`, 'agent', `${deps.label(nodeId)} needs input`), 'high')
      // One-shot by design (a stale "needs input" is worse than none): one warn, no retry.
      if (r.sent === 0 && r.failed > 0) log.warn('push.hook_failed', 'needs-input push failed on every device', { nodeId, reason: r.reason })
      if (r.state.subs.length !== state.subs.length) writePushState(deps.statePath, { ...readPushState(deps.statePath), subs: r.state.subs })
    })().catch((err: unknown) => log.warn('push.hook_failed', 'needs-input push failed', { cause: err instanceof Error ? err.message : String(err) }))
  }
}
