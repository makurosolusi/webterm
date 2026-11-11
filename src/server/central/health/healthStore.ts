// Durable store for Central health findings (ledger v30). One row per (project, fingerprint): a rescan refreshes it,
// a full scan closes what it no longer sees, a dismissed finding keeps its human reason and is never reopened by a scan.
import type { Database } from 'bun:sqlite'
import type {
  FindingDraft, FindingOrigin, FindingStatus, FindingView, HealthLevel, HealthRule, HealthScanView, HealthSummary,
} from '../../../shared/centralHealth'
import { allRows, execWrite, getRow, newId, tx, type LedgerContext, type Row } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'

/** Per-scan cap on per-finding events; the summary event still carries the full counts. */
export const HEALTH_EVENT_CAP = 100
export const DISMISS_REASON_MAX = 500
export const HEALTH_PAGE_DEFAULT = 50
export const HEALTH_PAGE_MAX = 200
const SCAN_ERROR_MAX = 2000
const SCAN_ACTOR = 'system:health'

export type HealthErrorCode = 'not_found' | 'invalid' | 'conflict'

/** Typed store error so routes can map it to 404/400/409. */
export class HealthStoreError extends Error {
  constructor(readonly code: HealthErrorCode, message: string) {
    super(message)
    this.name = 'HealthStoreError'
  }
}

export interface FinishScanInput {
  drafts: FindingDraft[]
  /** Rules that actually ran: only their open findings may be auto-fixed. */
  rules: HealthRule[]
  filesScanned: number
  /** A partial scan never closes findings. */
  truncated: boolean
  /** Review scans: the task whose diff was checked; auto-fix stays inside that task. */
  taskId?: string | null
}

export interface ListFindingsInput {
  projectId: string
  statuses?: FindingStatus[]
  severities?: HealthLevel[]
  rules?: HealthRule[]
  taskId?: string
  limit?: number
  offset?: number
}

export interface HealthStore {
  startScan(projectId: string, origin: FindingOrigin): HealthScanView
  finishScan(scanId: string, result: FinishScanInput): { scan: HealthScanView; opened: FindingView[]; fixed: FindingView[] }
  failScan(scanId: string, error: string): HealthScanView
  dismiss(id: string, reason: string, actor: string): FindingView
  reopen(id: string, actor: string): FindingView
  list(input: ListFindingsInput): FindingView[]
  get(id: string): FindingView | null
  summary(projectId: string): HealthSummary
  latestScan(projectId: string): HealthScanView | null
  lastScanAt(projectId: string, origin: FindingOrigin): number | null
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function toFinding(r: Row): FindingView {
  return {
    id: String(r['id']), projectId: String(r['project_id']), fingerprint: String(r['fingerprint']),
    origin: String(r['origin']) as FindingOrigin, rule: String(r['rule']) as HealthRule,
    severity: String(r['severity']) as HealthLevel, confidence: String(r['confidence']) as HealthLevel,
    file: String(r['file']), line: num(r['line']), title: String(r['title']), evidence: String(r['evidence']),
    source: String(r['source']), suggestion: String(r['suggestion']), status: String(r['status']) as FindingStatus,
    taskId: str(r['task_id']), dismissedReason: str(r['dismissed_reason']), dismissedBy: str(r['dismissed_by']),
    firstSeenAt: Number(r['first_seen_at']), lastSeenAt: Number(r['last_seen_at']), fixedAt: num(r['fixed_at']),
  }
}

function toScan(r: Row): HealthScanView {
  return {
    id: String(r['id']), projectId: String(r['project_id']), origin: String(r['origin']) as FindingOrigin,
    status: String(r['status']) as HealthScanView['status'], startedAt: Number(r['started_at']),
    finishedAt: num(r['finished_at']), filesScanned: Number(r['files_scanned']), truncated: Number(r['truncated']) === 1,
    opened: Number(r['opened']), fixed: Number(r['fixed']), error: str(r['error']),
  }
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ')
const SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END"

function pageNumber(value: number | undefined, def: number, label: string, min: number): number {
  if (value === undefined) return def
  if (!Number.isFinite(value) || value < min) throw new HealthStoreError('invalid', `health.list: ${label} must be a number >= ${min}, got ${value}`)
  return Math.trunc(value)
}

/** Health store bound to one ledger connection; `now` is the injected clock. */
export function createHealthStore(db: Database, now: () => number): HealthStore {
  const ctx: LedgerContext = { db, now }

  const findingRow = (id: string): Row | null => getRow(db, 'SELECT * FROM central_finding WHERE id = ?', id)
  const scanRow = (id: string): Row | null => getRow(db, 'SELECT * FROM central_health_scan WHERE id = ?', id)
  const mustScan = (id: string, op: string): HealthScanView => {
    const r = scanRow(id)
    if (!r) throw new HealthStoreError('not_found', `${op}: scan not found: ${id}`)
    return toScan(r)
  }
  const mustFinding = (id: string, op: string): FindingView => {
    const r = findingRow(id)
    if (!r) throw new HealthStoreError('not_found', `${op}: finding not found: ${id}`)
    return toFinding(r)
  }
  const findingEvent = (kind: string, f: FindingView, actor: string, correlationId: string, extra: Record<string, unknown> = {}): void => {
    appendEvent(ctx, {
      kind, actor, projectId: f.projectId, correlationId,
      payload: { findingId: f.id, rule: f.rule, severity: f.severity, file: f.file, line: f.line, title: f.title, taskId: f.taskId, ...extra },
    })
  }

  function upsert(scan: HealthScanView, d: FindingDraft, taskId: string | null, at: number): FindingView | null {
    const existing = getRow(db, 'SELECT * FROM central_finding WHERE project_id = ? AND fingerprint = ?', scan.projectId, d.fingerprint)
    if (!existing) {
      const id = newId()
      execWrite(db, `INSERT INTO central_finding (id, project_id, fingerprint, origin, rule, severity, confidence, file, line, title,
        evidence, source, suggestion, status, task_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        id, scan.projectId, d.fingerprint, scan.origin, d.rule, d.severity, d.confidence, d.file, d.line, d.title,
        d.evidence, d.source, d.suggestion, taskId, at, at)
      return mustFinding(id, 'health.finishScan')
    }
    const id = String(existing['id'])
    switch (String(existing['status']) as FindingStatus) {
      case 'open':
        execWrite(db, 'UPDATE central_finding SET line = ?, evidence = ?, last_seen_at = ? WHERE id = ?', d.line, d.evidence, at, id)
        return null
      case 'fixed':
        execWrite(db, `UPDATE central_finding SET status = 'open', fixed_at = NULL, line = ?, evidence = ?, last_seen_at = ? WHERE id = ?`,
          d.line, d.evidence, at, id)
        return mustFinding(id, 'health.finishScan')
      case 'dismissed':
        execWrite(db, 'UPDATE central_finding SET last_seen_at = ? WHERE id = ?', at, id)
        return null
    }
  }

  function autoFix(scan: HealthScanView, rules: HealthRule[], seen: Set<string>, taskId: string | null, at: number): FindingView[] {
    if (rules.length === 0) return []
    const taskScope = scan.origin === 'review' ? (taskId === null ? ' AND task_id IS NULL' : ' AND task_id = ?') : ''
    const params: unknown[] = [scan.projectId, scan.origin, ...rules, ...(scan.origin === 'review' && taskId !== null ? [taskId] : [])]
    const candidates = allRows(db, `SELECT * FROM central_finding WHERE project_id = ? AND origin = ? AND status = 'open'
      AND rule IN (${marks(rules.length)})${taskScope}`, ...params).map(toFinding).filter((f) => !seen.has(f.fingerprint))
    for (const f of candidates) execWrite(db, `UPDATE central_finding SET status = 'fixed', fixed_at = ? WHERE id = ?`, at, f.id)
    return candidates.map((f) => ({ ...f, status: 'fixed' as const, fixedAt: at }))
  }

  function latestScan(projectId: string): HealthScanView | null {
    const r = getRow(db, 'SELECT * FROM central_health_scan WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', projectId)
    return r ? toScan(r) : null
  }

  return {
    startScan(projectId, origin) {
      const id = newId()
      try {
        execWrite(db, `INSERT INTO central_health_scan (id, project_id, origin, status, started_at) VALUES (?, ?, ?, 'running', ?)`, id, projectId, origin, now())
      } catch (err) {
        throw new HealthStoreError('invalid', `health.startScan: cannot start ${origin} scan for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`)
      }
      return mustScan(id, 'health.startScan')
    },

    finishScan(scanId, result) {
      return tx(ctx, () => {
        const scan = mustScan(scanId, 'health.finishScan')
        if (scan.status !== 'running') throw new HealthStoreError('conflict', `health.finishScan: scan ${scanId} is already ${scan.status}`)
        const at = now()
        const taskId = result.taskId ?? null
        const seen = new Set<string>()
        const opened: FindingView[] = []
        for (const d of result.drafts) {
          seen.add(d.fingerprint)
          const f = upsert(scan, d, taskId, at)
          if (f) opened.push(f)
        }
        const fixed = result.truncated ? [] : autoFix(scan, result.rules, seen, taskId, at)
        execWrite(db, `UPDATE central_health_scan SET status = 'done', finished_at = ?, files_scanned = ?, truncated = ?, opened = ?, fixed = ? WHERE id = ?`,
          at, result.filesScanned, result.truncated ? 1 : 0, opened.length, fixed.length, scanId)
        for (const f of opened.slice(0, HEALTH_EVENT_CAP)) findingEvent('health.finding.opened', f, SCAN_ACTOR, scanId, { scanId })
        for (const f of fixed.slice(0, HEALTH_EVENT_CAP)) findingEvent('health.finding.fixed', f, SCAN_ACTOR, scanId, { scanId })
        const done = mustScan(scanId, 'health.finishScan')
        appendEvent(ctx, {
          kind: 'health.scan.finished', actor: SCAN_ACTOR, projectId: scan.projectId, correlationId: scanId,
          payload: { scanId, origin: scan.origin, taskId, filesScanned: done.filesScanned, truncated: done.truncated, opened: opened.length, fixed: fixed.length, rules: result.rules },
        })
        return { scan: done, opened, fixed }
      })
    },

    failScan(scanId, error) {
      return tx(ctx, () => {
        const scan = mustScan(scanId, 'health.failScan')
        if (scan.status !== 'running') throw new HealthStoreError('conflict', `health.failScan: scan ${scanId} is already ${scan.status}`)
        execWrite(db, `UPDATE central_health_scan SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`, now(), error.slice(0, SCAN_ERROR_MAX), scanId)
        return mustScan(scanId, 'health.failScan')
      })
    },

    dismiss(id, reason, actor) {
      const text = reason.trim()
      if (text.length === 0) throw new HealthStoreError('invalid', `health.dismiss: finding ${id} needs a reason`)
      if (text.length > DISMISS_REASON_MAX) throw new HealthStoreError('invalid', `health.dismiss: reason for finding ${id} exceeds ${DISMISS_REASON_MAX} characters`)
      return tx(ctx, () => {
        const f = mustFinding(id, 'health.dismiss')
        if (f.status !== 'open') throw new HealthStoreError('conflict', `health.dismiss: finding ${id} is ${f.status}, only open findings can be dismissed`)
        execWrite(db, `UPDATE central_finding SET status = 'dismissed', dismissed_reason = ?, dismissed_by = ? WHERE id = ?`, text, actor, id)
        const next = mustFinding(id, 'health.dismiss')
        findingEvent('health.finding.dismissed', next, actor, id, { reason: text })
        return next
      })
    },

    reopen(id, actor) {
      return tx(ctx, () => {
        const f = mustFinding(id, 'health.reopen')
        if (f.status !== 'dismissed') throw new HealthStoreError('conflict', `health.reopen: finding ${id} is ${f.status}, only dismissed findings can be reopened`)
        execWrite(db, `UPDATE central_finding SET status = 'open', dismissed_reason = NULL, dismissed_by = NULL, last_seen_at = ? WHERE id = ?`, now(), id)
        const next = mustFinding(id, 'health.reopen')
        findingEvent('health.finding.reopened', next, actor, id)
        return next
      })
    },

    list(input) {
      const limit = Math.min(HEALTH_PAGE_MAX, pageNumber(input.limit, HEALTH_PAGE_DEFAULT, 'limit', 1))
      const offset = pageNumber(input.offset, 0, 'offset', 0)
      const where = ['project_id = ?']
      const params: unknown[] = [input.projectId]
      const inFilter = (col: string, values: readonly string[] | undefined): void => {
        if (!values || values.length === 0) return
        where.push(`${col} IN (${marks(values.length)})`)
        params.push(...values)
      }
      inFilter('status', input.statuses)
      inFilter('severity', input.severities)
      inFilter('rule', input.rules)
      if (input.taskId !== undefined) { where.push('task_id = ?'); params.push(input.taskId) }
      return allRows(db, `SELECT * FROM central_finding WHERE ${where.join(' AND ')}
        ORDER BY ${SEVERITY_ORDER}, last_seen_at DESC, id LIMIT ? OFFSET ?`, ...params, limit, offset).map(toFinding)
    },

    get(id) {
      const r = findingRow(id)
      return r ? toFinding(r) : null
    },

    summary(projectId) {
      const rows = allRows(db, `SELECT severity, COUNT(*) AS n FROM central_finding WHERE project_id = ? AND status = 'open' GROUP BY severity`, projectId)
      const by = (s: HealthLevel): number => Number(rows.find((r) => r['severity'] === s)?.['n'] ?? 0)
      const high = by('high'), medium = by('medium'), low = by('low')
      return { open: high + medium + low, high, medium, low, lastScan: latestScan(projectId) }
    },

    latestScan,

    lastScanAt(projectId, origin) {
      const r = getRow(db, 'SELECT MAX(started_at) AS at FROM central_health_scan WHERE project_id = ? AND origin = ?', projectId, origin)
      return num(r?.['at'])
    },
  }
}
