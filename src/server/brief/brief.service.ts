// Morning brief service: which window to brief ("visit" state), a cached brief, and the
// precompute that keeps it warm so the card is served in milliseconds when a tab opens.
//
// A visit starts when the user comes back after more than AWAY_GAP_MS of no activity; its window
// is everything since the last activity before that gap. Activity = a visible-tab presence ping
// (channels/channelPresence) or, failing that, opening the brief itself. The state is a small
// JSON file in the data dir so it survives the restart that usually sits between two visits.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../logs'
import { buildBrief, type Brief } from './brief.model'
import type { BriefSource } from './brief.source'

const log = createLogger('brief')

/** Quiet time after which coming back counts as a new visit (and a fresh brief). */
export const AWAY_GAP_MS = 30 * 60_000
/** Window of the very first brief, when no activity was ever recorded. */
export const FIRST_WINDOW_MS = 24 * 60 * 60_000
/** A cached brief is reused at most this long even when no event arrived (Inbox counts age). */
export const CACHE_MAX_AGE_MS = 15_000
/** Events are coalesced this long before the warm brief is rebuilt. */
export const PRECOMPUTE_DEBOUNCE_MS = 1_000
/** lastActiveAt is written to disk at most this often while a visit goes on. */
const PERSIST_EVERY_MS = 60_000

export interface BriefState {
  lastActiveAt: number | null
  visitSince: number | null
  visitStartedAt: number | null
  dismissedVisit: number | null
}

export interface BriefResponse extends Brief {
  visitStartedAt: number
  /** True once the user dismissed this visit's card; ⌘K "Show morning brief" still shows it. */
  dismissed: boolean
}

export interface BriefServiceDeps {
  statePath: string
  now?: () => number
  /** Ledger handle, or null when the ledger is off (the brief is then empty). */
  read: (since: number, now: number) => BriefSource | null
  headSeq: () => number
  nodeLabel: (nodeId: string) => string
  workspaceLabel: (workspaceId: string) => string
  /** Last visible presence ping, or null when no tab pinged since boot. */
  lastVisibleAt?: () => number | null
  /** Event subscription for the precompute (production: eventBus); returns unsubscribe. */
  subscribe?: (pattern: string, fn: () => void) => () => void
  /** Presence sampling period; 0 = only on brief requests (tests). */
  sampleEveryMs?: number
}

const EMPTY: BriefState = { lastActiveAt: null, visitSince: null, visitStartedAt: null, dismissedVisit: null }

function loadState(path: string): BriefState {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return { ...EMPTY } } // first run: no file yet
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    const num = (k: keyof BriefState): number | null => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : null)
    return { lastActiveAt: num('lastActiveAt'), visitSince: num('visitSince'), visitStartedAt: num('visitStartedAt'), dismissedVisit: num('dismissedVisit') }
  } catch (err) {
    log.warn('brief.state_unreadable', 'brief state file is not valid JSON; starting fresh', { cause: err instanceof Error ? err.message : String(err) })
    return { ...EMPTY }
  }
}

export function createBriefService(deps: BriefServiceDeps) {
  const now = deps.now ?? Date.now
  const state = loadState(deps.statePath)
  let persistedAt = 0
  let cache: { key: string; at: number; brief: Brief } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function persist(force: boolean): void {
    const t = now()
    if (!force && t - persistedAt < PERSIST_EVERY_MS) return
    persistedAt = t
    try {
      mkdirSync(dirname(deps.statePath), { recursive: true })
      const tmp = `${deps.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, deps.statePath)
    } catch (err) {
      log.warn('brief.state_write_failed', 'saving brief state failed', { cause: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Records user activity at `at`; a gap longer than AWAY_GAP_MS opens a new visit. */
  function touch(at: number): void {
    let visitChanged = false
    if (state.visitStartedAt === null || state.lastActiveAt === null || at - state.lastActiveAt > AWAY_GAP_MS) {
      if (state.lastActiveAt === null || at > state.lastActiveAt) {
        state.visitSince = state.lastActiveAt ?? at - FIRST_WINDOW_MS
        state.visitStartedAt = at
        visitChanged = true
      }
    }
    if (state.lastActiveAt === null || at > state.lastActiveAt) state.lastActiveAt = at
    persist(visitChanged)
  }

  function samplePresence(): void {
    const v = deps.lastVisibleAt?.()
    if (typeof v === 'number') touch(v)
  }

  function build(since: number): Brief {
    const t = now()
    const key = `${since}:${deps.headSeq()}`
    if (cache && cache.key === key && t - cache.at < CACHE_MAX_AGE_MS) return cache.brief
    const src = deps.read(since, t)
    const brief = buildBrief({
      since, now: t, headSeq: src?.headSeq ?? 0, events: src?.events ?? [], inbox: src?.inbox ?? null, usage: src?.usage ?? null,
      nodeLabel: deps.nodeLabel, workspaceLabel: deps.workspaceLabel,
    })
    cache = { key, at: t, brief }
    return brief
  }

  function respond(): BriefResponse {
    const since = state.visitSince ?? now() - FIRST_WINDOW_MS
    const visitStartedAt = state.visitStartedAt ?? now()
    return { ...build(since), visitStartedAt, dismissed: state.dismissedVisit === visitStartedAt }
  }

  const unsubscribe = deps.subscribe?.('*', () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (state.visitSince === null) return
      try { build(state.visitSince) } catch (err) {
        log.warn('brief.precompute_failed', 'precomputing the brief failed', { cause: err instanceof Error ? err.message : String(err) })
      }
    }, PRECOMPUTE_DEBOUNCE_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })

  const sampler = deps.sampleEveryMs ? setInterval(samplePresence, deps.sampleEveryMs) : null
  ;(sampler as unknown as { unref?: () => void } | null)?.unref?.()

  return {
    touch,
    /** The current visit's brief; opening it counts as activity. */
    get(): BriefResponse {
      samplePresence()
      touch(now())
      return respond()
    },
    /** The current visit's brief without counting as activity (Telegram digest). */
    peek: (): BriefResponse => respond(),
    /** Hides this visit's card (persisted, so a reload does not bring it back). */
    dismiss(): BriefResponse {
      samplePresence()
      touch(now())
      state.dismissedVisit = state.visitStartedAt
      persist(true)
      return respond()
    },
    state: (): Readonly<BriefState> => ({ ...state }),
    stop(): void {
      unsubscribe?.()
      if (sampler) clearInterval(sampler)
      if (timer) clearTimeout(timer)
      timer = null
      persist(true)
    },
  }
}

export type BriefService = ReturnType<typeof createBriefService>
