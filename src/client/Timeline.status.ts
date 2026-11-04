// Status surfaces of the Activity timeline: per-workspace autonomy level badge and the event-chain
// integrity indicator. Pure parsers plus the two fetches (same credential as the rest of the UI).
import { useEffect, useState } from 'react'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'
import { CONTROL_LEVELS, type ControlLevel } from '../server/central/contracts/level.types'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export const CONTROL_URL = '/api/central/control?limit=200'
export const HEAD_URL = '/api/events/head?verify=1'

/** GET with the transport token; throws with the path + status on a non-2xx answer. */
export async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const token = peekToken()
  const res = await fetch(path, { headers: { Accept: 'application/json', ...(token === '' ? {} : { [TOKEN_HEADER]: token }) }, signal })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}

/* --- Autonomy level badge ---------------------------------------------------------------------- */

export interface ControlSnapshot {
  ceiling: ControlLevel
  global: ControlLevel
  /** Own per-project level, keyed by workspace id. */
  projects: Record<string, ControlLevel>
}

const rank = (l: ControlLevel): number => CONTROL_LEVELS.indexOf(l)
const isLevel = (v: unknown): v is ControlLevel => typeof v === 'string' && (CONTROL_LEVELS as readonly string[]).includes(v)

/** Parses `GET /api/central/control`; null when the shape is not what the guard serves. */
export function parseControl(body: unknown): ControlSnapshot | null {
  const b = rec(body)
  const global = rec(b.global).level
  if (!isLevel(b.ceiling) || !isLevel(global)) return null
  const projects: Record<string, ControlLevel> = {}
  for (const raw of Array.isArray(b.projects) ? b.projects : []) {
    const r = rec(raw)
    const scope = str(r.scope)
    if (scope?.startsWith('project:') && isLevel(r.level)) projects[scope.slice('project:'.length)] = r.level
  }
  return { ceiling: b.ceiling, global, projects }
}

/** Same rule as the server guard (`effectiveLevelOf`): the lowest of ceiling, global and own level. */
export function effectiveLevel(s: ControlSnapshot, workspaceId: string): ControlLevel {
  const own = s.projects[workspaceId] ?? CONTROL_LEVELS[CONTROL_LEVELS.length - 1]!
  return [s.ceiling, s.global, own].reduce((lo, l) => (rank(l) < rank(lo) ? l : lo))
}

/* --- Chain integrity ------------------------------------------------------------------------------ */

export type Integrity = { state: 'unknown' } | { state: 'ok'; seq: number } | { state: 'warning'; reason: string }

const DIVERGED = ['rewritten', 'truncated', 'unreadable']

/** Interprets `GET /api/events/head?verify=1`. */
export function parseIntegrity(body: unknown): Integrity {
  const b = rec(body)
  const verify = rec(b.verify)
  if (verify.ok === false) {
    const at = rec(verify.brokenAt)
    return { state: 'warning', reason: `Event chain broken at #${typeof at.seq === 'number' ? at.seq : '?'} (${str(at.reason) ?? 'mismatch'})` }
  }
  const anchor = str(b.anchorStatus)
  if (anchor && DIVERGED.includes(anchor)) return { state: 'warning', reason: `Anchor diverged: ${anchor}` }
  const start = str(b.startStatus)
  if (start && DIVERGED.includes(start)) return { state: 'warning', reason: `Anchor diverged at startup: ${start}` }
  if (verify.ok !== true) return { state: 'unknown' }
  return { state: 'ok', seq: typeof rec(b.head).seq === 'number' ? (rec(b.head).seq as number) : 0 }
}

/**
 * Level snapshot + chain integrity, re-read whenever `epoch` changes (each stream (re)connect).
 * A failed level read hides the badges (central off / not authorised); a failed head read is `unknown`.
 * ponytail: `verify=1` walks the whole chain per (re)connect; move to a cached server verdict if logs get huge.
 */
export function useTimelineStatus(enabled: boolean, epoch: number): { control: ControlSnapshot | null; integrity: Integrity } {
  const [control, setControl] = useState<ControlSnapshot | null>(null)
  const [integrity, setIntegrity] = useState<Integrity>({ state: 'unknown' })
  useEffect(() => {
    if (!enabled) return
    const ac = new AbortController()
    getJson(CONTROL_URL, ac.signal).then((b) => setControl(parseControl(b)), () => { if (!ac.signal.aborted) setControl(null) })
    getJson(HEAD_URL, ac.signal).then((b) => setIntegrity(parseIntegrity(b)), () => { if (!ac.signal.aborted) setIntegrity({ state: 'unknown' }) })
    return () => ac.abort()
  }, [enabled, epoch])
  return { control, integrity }
}
