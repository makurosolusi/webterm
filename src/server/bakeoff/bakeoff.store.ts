// Persistence of bake-off runs and candidates over the ledger (schema v20). Rows only; the lifecycle
// rules live in bakeoff.service.ts. The view types are the HTTP contract the client renders.
import { allRows, execWrite, getRow, type LedgerContext, type Row } from '../ledger/ledgerCore'

export type BakeoffStatus = 'running' | 'ready' | 'picked' | 'merged' | 'cleaned'
export type CandidateStatus = 'running' | 'done' | 'failed' | 'removed'

/** What the verifier judged, kept for the comparison card (no command output). */
export interface CandidateVerdict {
  status: 'done' | 'failed'
  reason: string
  summary: string
  filesChanged: number
  files: string[]
  diffStat: string
  tests: { passed: number; failed: number } | null
  typecheck: boolean | null
}

export interface CandidateView {
  id: string
  idx: number
  nodeId: string
  path: string
  branch: string
  status: CandidateStatus
  exitCode: number | null
  error: string | null
  costMicros: number | null
  durationMs: number | null
  /** Sealed server evidence passed `evidenceVerified` when the run settled. */
  verified: boolean
  verdict: CandidateVerdict | null
  startedAt: number
  finishedAt: number | null
}

export interface BakeoffView {
  id: string
  workspaceId: string | null
  repo: string
  baseBranch: string
  baseSha: string
  prompt: string
  status: BakeoffStatus
  winnerId: string | null
  inboxItemId: string | null
  createdAt: number
  updatedAt: number
  candidates: CandidateView[]
}

const LIST_MAX = 20
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function parseVerdict(v: unknown): CandidateVerdict | null {
  if (typeof v !== 'string') return null
  try { return JSON.parse(v) as CandidateVerdict } catch { return null } // a corrupt row shows "no verdict", not a 500
}

function toCandidate(r: Row): CandidateView {
  return {
    id: String(r['id']), idx: Number(r['idx']), nodeId: String(r['node_id']), path: String(r['path']), branch: String(r['branch']),
    status: r['status'] as CandidateStatus, exitCode: num(r['exit_code']), error: (r['error'] as string | null) ?? null,
    costMicros: num(r['cost_micros']), durationMs: num(r['duration_ms']), verified: Number(r['verified']) === 1,
    verdict: parseVerdict(r['verdict_json']), startedAt: Number(r['started_at']), finishedAt: num(r['finished_at']),
  }
}

export function createBakeoffStore(ctx: LedgerContext) {
  const { db } = ctx

  function candidates(bakeoffId: string): CandidateView[] {
    return allRows(db, 'SELECT * FROM bakeoff_candidate WHERE bakeoff_id = ? ORDER BY idx', bakeoffId).map(toCandidate)
  }

  function get(id: string): BakeoffView | null {
    const r = getRow(db, 'SELECT * FROM bakeoff WHERE id = ?', id)
    if (!r) return null
    return {
      id: String(r['id']), workspaceId: (r['workspace_id'] as string | null) ?? null, repo: String(r['repo']),
      baseBranch: String(r['base_branch']), baseSha: String(r['base_sha']), prompt: String(r['prompt']),
      status: r['status'] as BakeoffStatus, winnerId: (r['winner_id'] as string | null) ?? null,
      inboxItemId: (r['inbox_item_id'] as string | null) ?? null,
      createdAt: Number(r['created_at']), updatedAt: Number(r['updated_at']), candidates: candidates(id),
    }
  }

  return {
    get,
    /** Newest first, capped. */
    list(): BakeoffView[] {
      return allRows(db, 'SELECT id FROM bakeoff ORDER BY created_at DESC LIMIT ?', LIST_MAX).map((r) => get(String(r['id']))!)
    },
    insert(b: { id: string; workspaceId: string | null; repo: string; baseBranch: string; baseSha: string; prompt: string }): void {
      const now = ctx.now()
      execWrite(db, `INSERT INTO bakeoff (id, workspace_id, repo, base_branch, base_sha, prompt, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`, b.id, b.workspaceId, b.repo, b.baseBranch, b.baseSha, b.prompt, now, now)
    },
    insertCandidate(c: { id: string; bakeoffId: string; idx: number; nodeId: string; path: string; branch: string }): void {
      execWrite(db, `INSERT INTO bakeoff_candidate (id, bakeoff_id, idx, node_id, path, branch, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`, c.id, c.bakeoffId, c.idx, c.nodeId, c.path, c.branch, ctx.now())
    },
    finishCandidate(id: string, f: { status: 'done' | 'failed'; exitCode: number | null; error: string | null; costMicros: number | null; durationMs: number; verified: boolean; verdict: CandidateVerdict | null }): void {
      execWrite(db, `UPDATE bakeoff_candidate SET status = ?, exit_code = ?, error = ?, cost_micros = ?, duration_ms = ?, verified = ?, verdict_json = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`, f.status, f.exitCode, f.error, f.costMicros, f.durationMs, f.verified ? 1 : 0,
      f.verdict ? JSON.stringify(f.verdict) : null, ctx.now(), id)
    },
    markRemoved(id: string): void {
      execWrite(db, `UPDATE bakeoff_candidate SET status = 'removed' WHERE id = ?`, id)
    },
    setStatus(id: string, status: BakeoffStatus, extra: { winnerId?: string; inboxItemId?: string } = {}): void {
      execWrite(db, `UPDATE bakeoff SET status = ?, winner_id = COALESCE(?, winner_id), inbox_item_id = COALESCE(?, inbox_item_id), updated_at = ? WHERE id = ?`,
        status, extra.winnerId ?? null, extra.inboxItemId ?? null, ctx.now(), id)
    },
    /** Candidates left `running` by a previous process (their agent died with it). */
    orphans(): Array<{ id: string; bakeoffId: string; startedAt: number }> {
      return allRows(db, `SELECT id, bakeoff_id, started_at FROM bakeoff_candidate WHERE status = 'running'`)
        .map((r) => ({ id: String(r['id']), bakeoffId: String(r['bakeoff_id']), startedAt: Number(r['started_at']) }))
    },
  }
}

export type BakeoffStore = ReturnType<typeof createBakeoffStore>
