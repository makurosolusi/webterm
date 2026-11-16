// What happens when the connection (or the API's rate limit) comes back: ONE sweep per episode finds the work the
// outage hurt and takes each victim up a bounded ladder (workRecover.ladder.ts) until it is recovered, scheduled again
// or in a human's hands, then tells the user once. Triggers: link back online (after a grace), a boot that finds an
// outage newer than the last boot, and the instant a rate limit resets (a timer, not a poll). Nothing runs while the
// link is impaired or a limit is pending. Without a connectivity port the module does nothing (old behaviour).
import type { Database } from 'bun:sqlite'
import type { ConnectivityEpisode, ConnectivityPort } from '../../connectivity/connectivity.port'
import { getRow } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'
import { createLogger } from '../../logs'
import { queueCheckinReason } from './workCheckin'
import { reopenCheckinReason } from './workCheckin.requeue'
import { isTransientKind } from './workFailureKind'
import type { WorkStore } from './workModel'
import type { RateLimitHold } from './workRateLimit'
import { climb } from './workRecover.ladder'
import {
  BOOT_EVENT, MAX_CHECKIN_REQUEUES, RATE_LIMIT_LOOKBACK_MS, RECOVER_ACTOR, RECOVER_EVENT, RECOVER_TOOL, RECOVERY_HORIZON_MS, RETRY_SWEEP_MS,
  SUMMARY_EVENT, SWEEP_GRACE_MS, SWEPT_EVENT, TIMER_SLACK_MS, WINDOW_AFTER_MS, WINDOW_BEFORE_MS,
  type Outcome, type RecoverPorts, type SweepInfo, type SweepKey, type Verdict, type Victim,
} from './workRecover.model'
import { findVictims, settledTasks } from './workRecover.victims'

const log = createLogger('central.work')
/** A victim that carried on by itself was not helped by us: it is recorded but not counted in what the user is told. */
const SELF_HEALED = 'carried_on'

export interface RecoverTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface WorkRecoverDeps {
  db: Database
  store: WorkStore
  now(): number
  ports: RecoverPorts
  /** Looked up on every use: the detector may start after this module is wired. Null = no detector = inactive. */
  connectivity(): ConnectivityPort | null
  rateLimit?: Pick<RateLimitHold, 'resetAt' | 'onSet'>
  /** The one chat notice of a sweep; `key` is unique per sweep key so a repeat adds nothing. */
  announce(key: string, text: string): void
  timers?: RecoverTimers
}

export interface WorkRecover {
  /** Hooks the detector and the rate limit once one exists (safe to call on every tick), and runs the boot trigger. */
  attach(): void
  stop(): void
  /** Runs one sweep now (tests, and the triggers above). Idempotent per key unless `followUp`. */
  sweep(key: SweepKey, followUp?: boolean): Promise<void>
  /** Resolves when every queued sweep finished (the triggers fire and forget). */
  idle(): Promise<void>
}

const defaultTimers: RecoverTimers = {
  set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return h },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local `HH:MM`, the way the user reads a clock. */
export const clockOf = (ms: number): string => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

/** The single sentence of a sweep: real counts only. */
export function summaryText(info: SweepInfo, tally: Record<Outcome, number>): string {
  const head = info.what === 'rate_limit' ? 'The Claude rate limit reset'
    : info.to === null ? `Connection was down since ${clockOf(info.from)}` : `Connection was down ${clockOf(info.from)}–${clockOf(info.to)}`
  const n = tally.recovered + tally.rescheduled + tally.escalated
  const parts = [
    tally.recovered > 0 && `${tally.recovered} resumed`,
    tally.rescheduled > 0 && `${tally.rescheduled} waiting to retry`,
    tally.escalated > 0 && (tally.escalated === 1 ? '1 needs you' : `${tally.escalated} need you`),
  ].filter(Boolean)
  return `${head} · ${n} task${n === 1 ? '' : 's'} affected: ${parts.join(', ')}`
}

const WORST: Record<Outcome, number> = { recovered: 0, rescheduled: 1, escalated: 2 }

/** Builds the module; the caller decides when `attach` runs. */
export function createWorkRecover(deps: WorkRecoverDeps): WorkRecover {
  const { db, store, now, ports } = deps
  const ctx = { db, now }
  const timers = deps.timers ?? defaultTimers
  const bootAt = now()
  const handles = new Set<unknown>()
  const rateScheduled = new Set<number>()
  /** Sweeps that found the link impaired: they run on the next recovery. Memory only; a boot finds an unswept episode again. */
  const pending = new Map<string, SweepKey>()
  let chain: Promise<void> = Promise.resolve()
  let unsubscribe: (() => void) | null = null
  let unRate: (() => void) | null = null
  let attached = false

  const later = (fn: () => void, ms: number): void => {
    const h = timers.set(() => { handles.delete(h); fn() }, ms)
    handles.add(h)
  }
  const impaired = (): boolean => deps.connectivity()?.isImpaired() === true || (deps.rateLimit?.resetAt(now()) ?? null) !== null
  const sweptBefore = (key: string): boolean => getRow(db, "SELECT 1 AS one FROM event WHERE kind = ? AND json_extract(payload_json, '$.key') = ? LIMIT 1", SWEPT_EVENT, key) !== null
  const markSwept = (key: string): void => { if (!sweptBefore(key)) appendEvent(ctx, { kind: SWEPT_EVENT, actor: RECOVER_ACTOR, payload: { key } }) }

  const lastEvent = (taskId: string, key: string): Record<string, unknown> | null => {
    const r = getRow(db, "SELECT payload_json FROM event WHERE kind = ? AND correlation_id = ? AND json_extract(payload_json, '$.episode') = ? ORDER BY seq DESC LIMIT 1", RECOVER_EVENT, taskId, key)
    return r ? (JSON.parse(String(r.payload_json)) as Record<string, unknown>) : null
  }

  /** One `work.recover` event per action; a waiting victim that says the same thing again is not written again. */
  const record = (v: Victim, key: string, verdict: Verdict | { rung: number; outcome: string; reason: string; acted: boolean }): void => {
    const last = lastEvent(v.task.id, key)
    if (!verdict.acted && last?.rung === verdict.rung && last?.outcome === verdict.outcome && last?.reason === verdict.reason) return
    appendEvent(ctx, {
      kind: RECOVER_EVENT, actor: RECOVER_ACTOR, projectId: v.task.projectId, correlationId: v.task.id,
      payload: { assignmentId: v.assignment.id, rung: verdict.rung, kind: v.kind, outcome: verdict.outcome, episode: key, reason: verdict.reason, acted: verdict.acted },
    })
  }

  /** A lost wake goes back to the queue; past its attempts a human is told instead. */
  const climbCheckin = (v: Victim, sk: SweepKey): Verdict => {
    if (!isTransientKind(v.kind)) return { outcome: 'escalated', rung: 0, reason: `needs_human:${v.kind}`, acted: false }
    if (now() - sk.window.to > RECOVERY_HORIZON_MS) return { outcome: 'escalated', rung: 0, reason: 'recovery_window_passed', acted: false }
    const permit = ports.permit(v.task.projectId, RECOVER_TOOL)
    if (!permit.ok) return { outcome: 'rescheduled', rung: 0, reason: `control:${permit.code}`, acted: false }
    const attempt = reopenCheckinReason(db, now, { reasonId: v.reasonId as string, taskId: v.task.id, limit: MAX_CHECKIN_REQUEUES, episode: sk.key })
    return attempt === null
      ? { outcome: 'escalated', rung: 0, reason: 'limit:checkin_requeue', acted: false }
      : { outcome: 'rescheduled', rung: 0, reason: `checkin_requeued:${attempt}`, acted: false }
  }

  /** A human decides: Central is woken with the reason through the same durable queue every other stall uses. */
  const hand = (v: Victim, key: string, reason: string): void => {
    if (reason.startsWith('needs_human:')) return // auth / permanent: the existing duty path already owns these
    // Back to the chat that asked for the task (conversationId), the same route every other stall of it takes.
    queueCheckinReason(db, {
      kind: 'task_failed', conversationId: v.task.conversationId, dedupeKey: `recover:${v.task.id}:${key}`, projectId: v.task.projectId, taskId: v.task.id, now: now(),
      text: `automatic recovery after the interruption stopped (${reason}); task "${v.task.title.slice(0, 80)}" needs a decision`,
    })
  }

  async function verdictOf(v: Victim, sk: SweepKey): Promise<Verdict> {
    try {
      if (v.reasonId) return climbCheckin(v, sk)
      return await climb({ db, store, now, ports, key: sk, note: (victim, rung, reason) => record(victim, sk.key, { rung, outcome: 'fallthrough', reason, acted: true }) }, v)
    } catch (err) {
      log.error('work.recover_failed', `recovery of task ${v.task.id} failed`, { taskId: v.task.id, assignmentId: v.assignment.id, error: err instanceof Error ? err.message : String(err) })
      return { outcome: 'escalated', rung: 0, reason: `error:${err instanceof Error ? err.name : 'unknown'}`, acted: false }
    }
  }

  async function run(sk: SweepKey, followUp: boolean): Promise<void> {
    if (impaired()) { pending.set(sk.key, sk); return }
    pending.delete(sk.key)
    const first = !followUp && !sweptBefore(sk.key)
    if (!followUp && !first) return
    const settled = settledTasks(db, sk.key)
    const victims = findVictims({ db, store, agentState: (id) => ports.agent(id)?.state ?? null }, sk).filter((v) => !settled.has(v.task.id))
    // The attempt itself first: a lost wake of a task that was just brought back would only confuse Central.
    victims.sort((a, b) => Number(a.reasonId !== undefined) - Number(b.reasonId !== undefined))
    const finals = new Map<string, Outcome>()
    let retry = false
    for (const v of victims) {
      if (v.reasonId && finals.get(v.task.id) === 'recovered') continue
      const verdict = await verdictOf(v, sk)
      record(v, sk.key, verdict)
      if (verdict.outcome === 'escalated') hand(v, sk.key, verdict.reason)
      if (verdict.outcome === 'rescheduled' && !verdict.reason.startsWith('checkin_requeued')) retry = true
      if (verdict.reason === SELF_HEALED) continue
      const prev = finals.get(v.task.id)
      if (prev === undefined || WORST[verdict.outcome] > WORST[prev]) finals.set(v.task.id, verdict.outcome)
    }
    if (first) {
      markSwept(sk.key)
      announceOnce(sk, finals)
    }
    if (retry) later(() => { enqueue(sk, true) }, RETRY_SWEEP_MS)
  }

  const announceOnce = (sk: SweepKey, finals: ReadonlyMap<string, Outcome>): void => {
    if (finals.size === 0) return
    const tally: Record<Outcome, number> = { recovered: 0, rescheduled: 0, escalated: 0 }
    for (const o of finals.values()) tally[o] += 1
    appendEvent(ctx, { kind: SUMMARY_EVENT, actor: RECOVER_ACTOR, payload: { episodeId: sk.info.episodeId, key: sk.key, affected: finals.size, ...tally } })
    try {
      deps.announce(`recover:${sk.key}`, summaryText(sk.info, tally))
    } catch (err) {
      // The event above is the record; a failed chat write must not undo the sweep.
      log.warn('work.recover_notice_failed', `recovery notice of ${sk.key} failed`, { key: sk.key, error: err instanceof Error ? err.message : String(err) })
    }
  }

  function enqueue(sk: SweepKey, followUp = false): Promise<void> {
    chain = chain.then(() => run(sk, followUp)).catch((err: unknown) => log.error('work.recover_sweep_failed', `recovery sweep ${sk.key} failed`, { key: sk.key, error: err instanceof Error ? err.message : String(err) }))
    return chain
  }

  const episodeKey = (ep: ConnectivityEpisode): SweepKey => ({
    key: `episode:${ep.id}`, window: { from: ep.startedAt - WINDOW_BEFORE_MS, to: (ep.endedAt ?? now()) + WINDOW_AFTER_MS },
    info: { what: 'connection', episodeId: ep.id, from: ep.startedAt, to: ep.endedAt },
  })

  /** The link has been back for the grace: sweep the newest closed episode, then whatever an earlier impairment held up. */
  const onRecovered = (): void => {
    const ep = deps.connectivity()?.episodes(1)[0]
    if (ep && ep.endedAt !== null) void enqueue(episodeKey(ep))
    for (const sk of [...pending.values()]) void enqueue(sk)
  }

  /** Boot: an episode open or closed since the last boot (and not yet swept) is swept once under `boot:<bootAt>`. */
  const bootSweep = (port: ConnectivityPort): void => {
    const last = getRow(db, 'SELECT MAX(ts) AS ts FROM event WHERE kind = ?', BOOT_EVENT)?.ts
    const since = typeof last === 'number' ? last : bootAt - RECOVERY_HORIZON_MS
    appendEvent(ctx, { kind: BOOT_EVENT, actor: RECOVER_ACTOR, payload: { bootAt } })
    const fresh = port.episodes(5).filter((ep) => (ep.endedAt ?? bootAt) >= since && !sweptBefore(`episode:${ep.id}`))
    if (fresh.length === 0 || port.isImpaired()) return // an impaired link sweeps on its own recovery
    const newest = fresh[0] as ConnectivityEpisode
    const from = Math.min(...fresh.map((ep) => ep.startedAt))
    void enqueue({ key: `boot:${bootAt}`, window: { from: from - WINDOW_BEFORE_MS, to: bootAt }, info: { what: 'connection', episodeId: newest.id, from: newest.startedAt, to: newest.endedAt } })
      .then(() => { for (const ep of fresh) markSwept(`episode:${ep.id}`) })
  }

  return {
    attach() {
      const port = deps.connectivity()
      if (attached || !port) return
      attached = true
      unsubscribe = port.subscribe((state, from) => { if (state.state === 'online' && from !== 'online') later(onRecovered, SWEEP_GRACE_MS) })
      unRate = deps.rateLimit?.onSet((resetAt) => {
        if (rateScheduled.has(resetAt)) return
        rateScheduled.add(resetAt)
        later(() => {
          void enqueue({ key: `ratelimit:${resetAt}`, window: { from: resetAt - RATE_LIMIT_LOOKBACK_MS, to: resetAt + TIMER_SLACK_MS }, only: 'rate_limited', info: { what: 'rate_limit', episodeId: null, from: resetAt, to: resetAt } })
        }, Math.max(0, resetAt - now()) + TIMER_SLACK_MS)
      }) ?? null
      bootSweep(port)
    },
    stop() {
      unsubscribe?.()
      unRate?.()
      unsubscribe = null
      unRate = null
      attached = false
      for (const h of handles) timers.clear(h)
      handles.clear()
    },
    sweep: (sk, followUp = false) => enqueue(sk, followUp),
    idle: () => chain,
  }
}
