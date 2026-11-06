// Counter/timing sink for P2. In-memory and dependency-free so every ledger module can import it
// without cycles; a future exporter can read `snapshot()`.
export type MetricName =
  | 'migration_ms'
  | 'sqlite_busy'
  | 'lease_expired'
  | 'suspect'
  | 'stale_fence'
  | 'reaper_tick'
  | 'reaper_error'
  | 'retention_rows'

export interface MetricSnapshot {
  counters: Record<string, number>
  timings: Record<string, { count: number; totalMs: number; maxMs: number }>
}

export class LedgerMetrics {
  private readonly counters = new Map<string, number>()
  private readonly timings = new Map<string, { count: number; totalMs: number; maxMs: number }>()

  inc(name: MetricName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  observe(name: MetricName, ms: number): void {
    const current = this.timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 }
    current.count += 1
    current.totalMs += ms
    current.maxMs = Math.max(current.maxMs, ms)
    this.timings.set(name, current)
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(
        [...this.timings].map(([key, value]) => [key, { ...value }])
      ),
    }
  }

  reset(): void {
    this.counters.clear()
    this.timings.clear()
  }
}

export const ledgerMetrics = new LedgerMetrics()
