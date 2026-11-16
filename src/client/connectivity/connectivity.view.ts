// What the user reads about the Claude link: pure text + tone from a displayed state. No URL, no host, ever.
import type { NetState } from './connectivity.store'

export type ShownKind = 'degraded' | 'offline' | 'recovered'
export interface Shown { kind: ShownKind; net: NetState }

export interface ConnectivityView {
  kind: ShownKind
  tone: 'warning' | 'error' | 'prominent'
  icon: string
  /** One line for the status bar. */
  label: string
  tooltip: string
  /** Spoken once per change of kind/scope (carries no time, so a new `since` alone never re-announces). */
  announce: string
}

/** Optional trailing text on "Back online", reserved for the number of resumed tasks (filled in by the engine wave). */
export interface RecoveredNote { note?: string }

const CAUSE_TEXT: Record<NonNullable<NetState['cause']>, string> = {
  dns: 'the name lookup failed',
  tcp: 'the connection was refused or dropped',
  tls: 'the secure handshake failed',
  timeout: 'the request timed out',
  http: 'the server answered with an error',
  unknown: 'the cause is unknown',
}

const PAUSED = 'work is paused, not failed'
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function span(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'under a minute'
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

function lead(net: NetState): string {
  if (net.scope === 'network') return 'Your network looks offline'
  if (net.scope === 'api') return "Can't reach the Claude API or its proxy"
  return 'Claude API unreachable'
}

export function buildView(shown: Shown, now: number, extra: RecoveredNote = {}): ConnectivityView {
  const { kind, net } = shown
  const since = clock(net.since)
  const cause = net.cause ? ` Cause: ${CAUSE_TEXT[net.cause]}.` : ''
  const lasted = `Since ${since} (${span(Math.max(0, now - net.since))}).${cause}`
  if (kind === 'offline') {
    return {
      kind, tone: 'error', icon: 'debug-disconnect',
      label: `${lead(net)} since ${since} · ${PAUSED}`,
      tooltip: `${lasted} Work resumes on its own when the connection is back.`,
      announce: `${lead(net)}. Work is paused, not failed.`,
    }
  }
  if (kind === 'degraded') {
    return {
      kind, tone: 'warning', icon: 'warning',
      label: 'Connection to Claude is unstable',
      tooltip: `${lasted} Work continues and slows down when needed.`,
      announce: 'Connection to Claude is unstable.',
    }
  }
  return {
    kind, tone: 'prominent', icon: 'check',
    label: extra.note ? `Back online · ${extra.note}` : 'Back online',
    tooltip: 'The connection to Claude is back.',
    announce: 'Connection to Claude is back.',
  }
}
