// Fires routines from the clock and from the Senses bus.
//
// Schedule: a tick (and one at start) takes every enabled routine whose `next_run_at` has passed.
// Missed slots collapse into ONE run for the latest slot within the 7-day window, labelled
// `catch_up` when it is late; older ones become a single `skipped` row (Claude Code Desktop
// scheduled tasks; Orca `service.ts:234-262` `getLatestAutomationOccurrence` + `advanceNextRun`).
// The next slot is computed from now, so a machine that slept for days fires once, not N times.
//
// Event: trailing debounce per routine (a burst is one run). Events from routines themselves and
// from agents a routine is running are ignored (no self-wake loop, PLAN rnd/04 pitfall).
import type { EventBus } from '../events/eventBus'
import { kindMatches } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { latestCronBetween, nextCronAfter } from './routineCron'
import { CATCH_UP_WINDOW_MS, EVENT_DEBOUNCE_DEFAULT_MS, type Routine } from './routineModel'
import { ROUTINE_SOURCE, type FireResult, type RoutineRunner } from './routineRunner'
import type { RoutineStore } from './routineStore'

export const ROUTINE_TICK_MS = 30_000

export interface SchedulerDeps {
  store: RoutineStore
  runner: RoutineRunner
  bus: Pick<EventBus, 'subscribe'>
  now: () => number
  tickMs?: number
  /** Called with every run the scheduler starts (tests await `done`). */
  onFire?: (fired: FireResult) => void
}

export function createRoutineScheduler(deps: SchedulerDeps) {
  const tickMs = deps.tickMs ?? ROUTINE_TICK_MS
  const fired = (f: FireResult): void => deps.onFire?.(f)
  let eventRoutines: Routine[] = []
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; trusted: boolean }>()
  let interval: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  function tick(): void {
    const now = deps.now()
    for (const r of deps.store.due(now)) {
      if (r.trigger.type !== 'schedule' || r.nextRunAt === null) continue
      const { cron } = r.trigger
      // Advanced first: a slow precheck or a throwing run can never fire the same slot twice.
      deps.store.setNextRun(r.id, nextCronAfter(cron, now))
      const latest = latestCronBetween(cron, Math.max(r.nextRunAt, now - CATCH_UP_WINDOW_MS), now)
      if (latest === null) {
        deps.store.addRun({ routineId: r.id, trigger: 'catch_up', status: 'skipped', reason: 'missed: machine was off or asleep for more than 7 days', scheduledFor: r.nextRunAt })
        continue
      }
      fired(deps.runner.fire(r, now - latest > 2 * tickMs ? 'catch_up' : 'schedule', { scheduledFor: latest }))
    }
  }

  function onEvent(e: SenseEvent): void {
    if (e.source === ROUTINE_SOURCE || deps.runner.isOwnChild(e.nodeId)) return
    for (const r of eventRoutines) {
      if (r.trigger.type !== 'event' || !kindMatches(r.trigger.pattern, e.kind)) continue
      if (r.workspaceId && e.workspaceId && r.workspaceId !== e.workspaceId) continue
      const open = pending.get(r.id)
      if (open) { open.trusted ||= e.trust === 'trusted'; continue }
      const entry = {
        trusted: e.trust === 'trusted',
        timer: setTimeout(() => {
          pending.delete(r.id)
          const current = deps.store.get(r.id)
          if (current?.enabled) fired(deps.runner.fire(current, 'event', { untrusted: !entry.trusted }))
        }, r.trigger.debounceMs ?? EVENT_DEBOUNCE_DEFAULT_MS),
      }
      pending.set(r.id, entry)
    }
  }

  /** Reloads the event-triggered routines (call after any create/update/delete). */
  function refresh(): void {
    eventRoutines = deps.store.list().filter((r) => r.enabled && r.trigger.type === 'event')
  }

  return {
    tick,
    refresh,
    start(): void {
      if (interval) return
      deps.store.failOrphans()
      refresh()
      unsubscribe = deps.bus.subscribe('*', onEvent)
      tick()
      interval = setInterval(tick, tickMs)
      interval.unref?.()
    },
    stop(): void {
      if (interval) clearInterval(interval)
      interval = null
      unsubscribe?.()
      unsubscribe = null
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
    },
  }
}

export type RoutineScheduler = ReturnType<typeof createRoutineScheduler>
