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
import { buildPayload, sendPush, type PushKind, type PushPayload, type SendOutcome } from './push.send'
import { readPushState, writePushState, type PushState } from './push.store'
import type { VapidKeys } from './webPush.crypto'

const log = createLogger('push')
export const WEB_PUSH_INTERVAL_MS = 3000
/** Same "you were away" gap the brief uses to open a new visit (brief.service AWAY_GAP_MS). */
export const BRIEF_AWAY_MS = 30 * 60_000
/** No "brief ready" ping in the small hours. */
export const BRIEF_EARLIEST_HOUR = 7
const BRIEF_RECHECK_MS = 10 * 60_000

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

/** Sends one payload to every subscription; drops the ones the push service says are gone. */
export async function fanOut(deps: WebPushDeps, state: PushState, payload: PushPayload, urgency: 'normal' | 'high'): Promise<{ state: PushState; sent: number }> {
  if (state.subs.length === 0) return { state, sent: 0 }
  const keys = await deps.keys()
  const outcomes: SendOutcome[] = []
  for (const sub of state.subs) outcomes.push(await sendPush(sub, payload, keys, { fetch: deps.fetch, nowSec: Math.floor(deps.now() / 1000), urgency }))
  const subs = state.subs.filter((_, i) => outcomes[i] !== 'gone')
  return { state: { ...state, subs }, sent: outcomes.filter((o) => o === 'sent').length }
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
    for (const item of items) {
      if (sent.has(item.id)) continue
      const verdict = attentionFor(item, deps.attention)
      if (verdict === 'hold') { held.push(item.id); continue }
      if (verdict === 'push') {
        const r = await fanOut(deps, state, buildPayload(item.id, item.kind as PushKind, item.title), item.kind === 'gate' ? 'high' : 'normal')
        state = r.state
        if (r.sent === 0) continue // every device failed: retry next sweep
        pushed.push(item.id)
      }
      sent.add(item.id)
    }
    state = { ...state, sent: [...sent] }
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
      if (r.state.subs.length !== state.subs.length) writePushState(deps.statePath, { ...readPushState(deps.statePath), subs: r.state.subs })
    })().catch((err: unknown) => log.warn('push.hook_failed', 'needs-input push failed', { cause: err instanceof Error ? err.message : String(err) }))
  }
}
