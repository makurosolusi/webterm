// Client side of /api/replay (src/server/replay/replay.route.ts): product text, paged loading and
// the lane geometry of the scrub bar. The scrub fold itself (`stateAt`) is the server's pure model.
import { getJson } from '../Timeline.status'
import { LANES, type Lane, type ReplayItem } from '../../server/replay/replay.model'
import type { CheckpointAt } from '../../server/replay/replay.checkpoint'

export { LANES, stateAt, type Lane, type ReplayItem } from '../../server/replay/replay.model'
export const REPLAY_API = '/api/replay'
/** Pages loaded per "Load more" (each page is at most the server's max). */
export const REPLAY_PAGE = 200

export const REPLAY_TEXT = {
  command: 'Replay Session…',
  title: 'Session replay',
  intro: 'Scrub through what happened: conversation turns, tool calls, approvals, file checkpoints, browser actions and cost, on one timeline.',
  scope: 'Scope', workspace: 'Whole workspace', range: 'Time range',
  ranges: { hour: 'Last hour', day: 'Last 24 hours', week: 'Last 7 days', all: 'All' },
  lanes: { transcript: 'Transcript', tool: 'Tools & receipts', approval: 'Approvals', file: 'File changes', browser: 'Browser', cost: 'Cost' } satisfies Record<Lane, string>,
  scrub: 'Playhead', loadMore: 'Load more', loading: 'Loading…', empty: 'Nothing recorded in this range.',
  transcriptAt: 'Transcript up to here', noTranscript: 'No transcript lines up to here.',
  checkpointAt: (seq: number, base: number | null) => (base === null ? `Checkpoint #${seq} (first one, no earlier checkpoint to diff against)` : `Checkpoint #${seq}: changes since #${base}`),
  noCheckpoint: 'No checkpoint before this moment.',
  noChanges: 'No file changes in this checkpoint.',
  rewindHere: 'Rewind to here',
  costAt: (usd: string) => `Cost up to here: ${usd}`,
  terminal: 'Terminal (live scrollback)',
  noTerminal: 'Terminal snapshots are not recorded per moment; move the playhead to the end to see the live scrollback.',
  truncated: '… (diff truncated)',
} as const

export type RangeKey = keyof typeof REPLAY_TEXT.ranges
const RANGE_MS: Record<RangeKey, number | null> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, all: null }

/** `from` for a preset relative to `now`; 0 = no lower bound. */
export const rangeFrom = (key: RangeKey, now: number): number => { const ms = RANGE_MS[key]; return ms === null ? 0 : Math.max(0, now - ms) }

export interface ReplayScopeQuery { workspaceId: string; nodeId: string | null; from: number }
const scopeQuery = (q: ReplayScopeQuery): string =>
  `workspace=${encodeURIComponent(q.workspaceId)}${q.nodeId ? `&node=${encodeURIComponent(q.nodeId)}` : ''}&from=${q.from}`

export async function fetchReplayPage(q: ReplayScopeQuery, cursor: string | null): Promise<{ items: ReplayItem[]; nextCursor: string | null }> {
  return getJson(`${REPLAY_API}?${scopeQuery(q)}&limit=${REPLAY_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`) as Promise<{ items: ReplayItem[]; nextCursor: string | null }>
}

export interface ReplayStateView {
  t: number
  transcript: { ts: number; nodeId: string; text: string }[]
  checkpoint: CheckpointAt | null
  costMicros: number
  scrollback: { asOf: number; text: string } | null
}

export async function fetchReplayState(q: ReplayScopeQuery, t: number): Promise<ReplayStateView> {
  return getJson(`${REPLAY_API}/state?${scopeQuery(q)}&t=${t}`) as Promise<ReplayStateView>
}

export const formatUsd = (micros: number): string => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`

/** Left offset (0..100 %) of `ts` on a bar spanning [min, max]. */
export const pct = (ts: number, min: number, max: number): number => (max <= min ? 0 : ((ts - min) / (max - min)) * 100)

/** Items per lane, keeping the global order. */
export function byLane(items: readonly ReplayItem[]): Record<Lane, ReplayItem[]> {
  const out = Object.fromEntries(LANES.map((l) => [l, [] as ReplayItem[]])) as Record<Lane, ReplayItem[]>
  for (const i of items) out[i.lane].push(i)
  return out
}
