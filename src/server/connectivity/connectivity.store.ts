// Episode history in `connectivity_episode` (ledgerSchemaV37.ts), bounded by age and by row count so a flapping
// link cannot grow the ledger without limit. Synchronous bun:sqlite, like the other ledger stores.
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { ConnCause, ConnScope, ConnectivityEpisode } from './connectivity.port'

/** Episodes older than this are deleted when a new one opens. */
export const EPISODE_RETENTION_DAYS = 30
/** Newest rows kept at most, whatever their age. */
export const EPISODE_MAX_ROWS = 500
const DAY_MS = 86_400_000

export interface EpisodeStore {
  /** The episode with no end, if any (a restart resumes it). */
  open(): ConnectivityEpisode | null
  begin(state: ConnectivityEpisode['state'], at: number, cause: ConnCause | null, scope: ConnScope | null): void
  /** Updates the cause/scope of the open episode (the latest failure explains it best). */
  annotate(cause: ConnCause | null, scope: ConnScope | null): void
  /** Closes the open episode, if any. */
  end(at: number): void
  recent(limit: number, now: number): ConnectivityEpisode[]
}

type Row = { id: string; state: string; started_at: number; ended_at: number | null; cause: string | null; scope: string | null }
const SELECT = 'SELECT id, state, started_at, ended_at, cause, scope FROM connectivity_episode'

export function createEpisodeStore(db: Database, now: () => number): EpisodeStore {
  const toEpisode = (r: Row, at: number): ConnectivityEpisode => ({
    id: r.id, state: r.state as ConnectivityEpisode['state'], startedAt: r.started_at, endedAt: r.ended_at,
    durationMs: Math.max(0, (r.ended_at ?? at) - r.started_at), cause: r.cause as ConnCause | null, scope: r.scope as ConnScope | null,
  })
  const prune = (): void => {
    db.query('DELETE FROM connectivity_episode WHERE ended_at IS NOT NULL AND started_at < ?').run(now() - EPISODE_RETENTION_DAYS * DAY_MS)
    db.query(`DELETE FROM connectivity_episode WHERE id NOT IN (SELECT id FROM connectivity_episode ORDER BY started_at DESC, rowid DESC LIMIT ?)
      AND ended_at IS NOT NULL`).run(EPISODE_MAX_ROWS)
  }
  return {
    open: () => {
      const r = db.query(`${SELECT} WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get() as Row | null
      return r ? toEpisode(r, now()) : null
    },
    begin: (state, at, cause, scope) => {
      db.query('INSERT INTO connectivity_episode (id, state, started_at, cause, scope) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), state, at, cause, scope)
      prune()
    },
    annotate: (cause, scope) => { db.query('UPDATE connectivity_episode SET cause = ?, scope = ? WHERE ended_at IS NULL').run(cause, scope) },
    end: (at) => { db.query('UPDATE connectivity_episode SET ended_at = ? WHERE ended_at IS NULL').run(at) },
    recent: (limit, at) => (db.query(`${SELECT} ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(Math.max(1, Math.min(limit, EPISODE_MAX_ROWS))) as Row[]).map((r) => toEpisode(r, at)),
  }
}
