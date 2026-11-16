// Latency telemetry for browser verbs and `browser_read` phases: one wrapper, a fixed-size ring buffer in memory,
// numbers only. A record carries ONLY the keys in LATENCY_KEYS: never a full URL, page text, typed text or cookie.
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'

const log = createLogger('browser.latency')

/** Ring capacity: the oldest entry is dropped first. */
export const LATENCY_BUFFER_MAX = 500
/** The only keys a record may carry (`at` = epoch ms of the end, used by `sinceMs`). */
export const LATENCY_KEYS = ['verb', 'ms', 'ok', 'code', 'host', 'at', 'apiMs'] as const
const CODE_MAX_CHARS = 40
const P50 = 0.5
const P95 = 0.95

export interface LatencyRecord { verb: string; ms: number; ok: boolean; at: number; code?: string; host?: string; apiMs?: number }
export interface VerbLatency { count: number; okRate: number; p50: number; p95: number; max: number }
/** Per-call extras: `url` is reduced to its host; `judge` classifies a returned (non-thrown) result; `apiMs` is a pass-through number. */
export interface TimedMeta { url?: string; apiMs?: number; judge?: (result: never) => { ok: boolean; code?: string } }

/** Nearest-rank percentile of an ascending array. */
const rank = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0
const round = (n: number): number => Math.round(n * 100) / 100

/** Short machine code of a thrown value (never its message). */
function codeOf(err: unknown): string {
  const e = err as { code?: unknown; reason?: unknown } | null // BrowserError.code, BlockedError.reason: both enums
  const c = e?.code ?? e?.reason
  return typeof c === 'string' && /^[a-z0-9_.-]+$/i.test(c) ? c.slice(0, CODE_MAX_CHARS) : 'error'
}

/** Builds a recorder; `perf`/`wall` are injectable clocks for tests. */
export function createLatencyRecorder(opts: { capacity?: number; perf?: () => number; wall?: () => number } = {}) {
  const capacity = opts.capacity ?? LATENCY_BUFFER_MAX
  const perf = opts.perf ?? (() => performance.now())
  const wall = opts.wall ?? (() => Date.now())
  const buf: LatencyRecord[] = []

  /** Appends one record built from the allowed keys only. */
  function record(verb: string, ms: number, ok: boolean, extra: { code?: string; url?: string; apiMs?: number } = {}): void {
    const rec: LatencyRecord = { verb, ms: round(ms), ok, at: wall() }
    if (extra.code !== undefined) rec.code = extra.code
    if (extra.url !== undefined) rec.host = hostOnly(extra.url)
    if (typeof extra.apiMs === 'number' && Number.isFinite(extra.apiMs)) rec.apiMs = round(extra.apiMs)
    buf.push(rec)
    if (buf.length > capacity) buf.splice(0, buf.length - capacity)
  }

  /** Runs `fn`, records its wall time (also when it throws) and returns/rethrows exactly what `fn` did. */
  async function timed<T>(verb: string, fn: () => Promise<T>, meta: TimedMeta = {}): Promise<T> {
    const t0 = perf()
    const safe = (ok: boolean, code?: string): void => {
      try {
        record(verb, perf() - t0, ok, { ...(code ? { code } : {}), ...(meta.url !== undefined ? { url: meta.url } : {}), ...(meta.apiMs !== undefined ? { apiMs: meta.apiMs } : {}) })
      } catch (err) {
        log.warn('browser.latency.record_failed', 'latency record failed', { verb, error: err instanceof Error ? err.name : 'unknown' })
      }
    }
    let result: T
    try {
      result = await fn()
    } catch (err) {
      safe(false, codeOf(err))
      throw err
    }
    const verdict = meta.judge ? (meta.judge as (r: T) => { ok: boolean; code?: string })(result) : { ok: true }
    safe(verdict.ok, verdict.code)
    return result
  }

  /** Per verb: count, success rate, p50/p95/max of ms; `sinceMs` = only the last N ms. */
  function summary(q: { sinceMs?: number } = {}): Record<string, VerbLatency> {
    const from = q.sinceMs === undefined ? 0 : wall() - q.sinceMs
    const by = new Map<string, LatencyRecord[]>()
    for (const r of buf) if (r.at >= from) by.set(r.verb, [...(by.get(r.verb) ?? []), r])
    const out: Record<string, VerbLatency> = {}
    for (const [verb, rs] of by) {
      const ms = rs.map((r) => r.ms).sort((a, b) => a - b)
      out[verb] = { count: rs.length, okRate: round(rs.filter((r) => r.ok).length / rs.length), p50: rank(ms, P50), p95: rank(ms, P95), max: ms[ms.length - 1] ?? 0 }
    }
    return out
  }

  return { timed, summary, records: (): readonly LatencyRecord[] => buf.slice() }
}

export type LatencyRecorder = ReturnType<typeof createLatencyRecorder>

let active: LatencyRecorder | null = createLatencyRecorder()
/** The process-wide recorder (null only when a test switches it off). */
export const activeLatency = (): LatencyRecorder | null => active
export const setActiveLatency = (r: LatencyRecorder | null): void => { active = r }

/** Times through the process-wide recorder; a no-op passthrough when none is active. */
export const timed = <T>(verb: string, fn: () => Promise<T>, meta?: TimedMeta): Promise<T> => (active ? active.timed(verb, fn, meta) : fn())
/** Summary of the process-wide recorder. */
export const latencySummary = (q: { sinceMs?: number } = {}): Record<string, VerbLatency> => active?.summary(q) ?? {}
