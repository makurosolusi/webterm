/**
 * v37: `connectivity_episode` (one row per stretch in which the server could not reach the Claude API).
 *
 * Why: Central is a Claude process, so it cannot think while offline; the detector is plain server code and its
 * history must outlive a restart (an episode still open at boot is resumed, not forgotten) and feed later waves
 * (pause penalties while impaired, summaries of how long and why). `state` is the state the episode lasted in
 * ('degraded' | 'offline'); `cause` is a bounded class (dns|tcp|tls|timeout|http|unknown) and `scope` is
 * 'network' | 'api', never a URL, host or header. `ended_at` NULL = still open.
 * Additive and idempotent (IF NOT EXISTS); nothing to backfill.
 */
import type { Database } from 'bun:sqlite'

export function applyV37(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS connectivity_episode (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      cause TEXT,
      scope TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_connectivity_episode_started ON connectivity_episode (started_at)`)
}
