// Runs health scans for Central: single-flight per project, failures recorded on the scan row (never thrown),
// and a daily auto-scan driven by the work supervisor's tick. One instance per ledger db (`healthServiceFor`),
// so the board route, the Central tools and the tick all see the same running set.
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { FindingOrigin, HealthScanView } from '../../../shared/centralHealth'
import { allRows } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import { projectRepo } from '../../orchestratorRunProduction'
import { notifyFinished } from './healthNotify'
import { createHealthStore, type HealthStore } from './healthStore'
import { scanProject, type ScanResult } from './healthScan'

/** A project is auto-scanned at most once per this interval. */
export const HEALTH_AUTO_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Auto-scans started per supervisor tick. */
export const HEALTH_AUTO_SCAN_PER_TICK = 1

const log = createLogger('central.health')
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface HealthServiceDeps {
  db: Database
  now(): number
  store: HealthStore
  /** Repository folder of a project, or null when it has none. */
  cwdOf(projectId: string): string | null
  /** Test seam: the deterministic scanner. */
  scan?: (cwd: string) => Promise<ScanResult>
}

export interface HealthService {
  /**
   * Scans one project; a second call while one runs returns the running one. The scan row is written
   * synchronously (so `store.latestScan` shows it at once); the promise never rejects, a failure ends the
   * scan as `failed`. Throws synchronously only when the scan cannot be recorded (e.g. unknown project).
   */
  runScan(projectId: string, origin?: FindingOrigin): Promise<HealthScanView>
  /** Starts at most `HEALTH_AUTO_SCAN_PER_TICK` due scans, and none while any scan runs; never throws. */
  autoScanDue(at: number): Promise<void>
  /** Whether a scan of `projectId` is running in this process. */
  running(projectId: string): boolean
}

/** Health scan runner bound to one ledger db. */
export function createHealthService({ db, now, store, cwdOf, scan = (cwd) => scanProject(cwd) }: HealthServiceDeps): HealthService {
  const inFlight = new Map<string, Promise<HealthScanView>>()

  const failed = (started: HealthScanView, error: string): HealthScanView => {
    try {
      return store.failScan(started.id, error)
    } catch (err) {
      log.error('health.fail_scan_failed', `could not record failure of scan ${started.id}`, { scanId: started.id, projectId: started.projectId, error: errorText(err) })
      return { ...started, status: 'failed', finishedAt: now(), error }
    }
  }

  async function execute(started: HealthScanView): Promise<HealthScanView> {
    const cwd = cwdOf(started.projectId)
    if (cwd === null) return failed(started, `project ${started.projectId} has no repository folder to scan`)
    try {
      const finished = store.finishScan(started.id, await scan(cwd))
      notifyFinished(db, finished, now())
      return finished.scan
    } catch (err) {
      log.warn('health.scan_failed', `health scan ${started.id} of project ${started.projectId} failed`, { scanId: started.id, projectId: started.projectId, error: errorText(err) })
      return failed(started, `scan failed: ${errorText(err)}`)
    }
  }

  function runScan(projectId: string, origin: FindingOrigin = 'scan'): Promise<HealthScanView> {
    const live = inFlight.get(projectId)
    if (live) return live
    const started = store.startScan(projectId, origin)
    const p = execute(started).finally(() => inFlight.delete(projectId))
    inFlight.set(projectId, p)
    return p
  }

  function dueProjects(at: number): string[] {
    const due: Array<{ id: string; last: number }> = []
    for (const r of allRows(db, 'SELECT id FROM project ORDER BY id')) {
      const id = String(r['id'])
      const cwd = cwdOf(id)
      if (cwd === null || !existsSync(cwd)) continue
      const last = store.lastScanAt(id, 'scan')
      if (last === null || at - last >= HEALTH_AUTO_SCAN_INTERVAL_MS) due.push({ id, last: last ?? -Infinity })
    }
    return due.sort((a, b) => a.last - b.last).slice(0, HEALTH_AUTO_SCAN_PER_TICK).map((d) => d.id)
  }

  return {
    runScan,
    async autoScanDue(at) {
      // ponytail: one scan process-wide at a time; per-project parallelism if many projects fall behind.
      if (inFlight.size > 0) return
      let ids: string[]
      try { ids = dueProjects(at) } catch (err) {
        log.error('health.auto_scan_list_failed', `could not list projects due for a health scan at ${at}`, { at, error: errorText(err) })
        return
      }
      for (const id of ids) {
        try { await runScan(id, 'scan') } catch (err) {
          log.error('health.auto_scan_failed', `auto health scan of project ${id} could not start`, { projectId: id, error: errorText(err) })
        }
      }
    },
    running: (projectId) => inFlight.has(projectId),
  }
}

const services = new WeakMap<Database, HealthService>()

/** The process-wide health service of `db` (created on first use with the production repo lookup). */
export function healthServiceFor(db: Database, now: () => number): HealthService {
  let service = services.get(db)
  if (!service) {
    service = createHealthService({ db, now, store: createHealthStore(db, now), cwdOf: (id) => projectRepo(db, id) })
    services.set(db, service)
  }
  return service
}
