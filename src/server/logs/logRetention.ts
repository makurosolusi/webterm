// Retention of the daily log files: by age and by total size, at boot and then daily. The file sink's own
// per-file rotation keeps single files small; this keeps the directory small. Never throws.
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_RETENTION_DAYS = 14
export const DEFAULT_RETENTION_MAX_MB = 200
export const MAX_RETENTION_DAYS = 3650
export const MAX_RETENTION_MB = 100_000
const DAY_MS = 86_400_000
const FILE_NAME = /^webterm-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/

export interface RetentionPolicy { maxAgeDays: number; maxBytes: number }
export interface PurgeResult { removedFiles: number; freedBytes: number; remainingBytes: number; remainingFiles: number }
export interface LogFileInfo { name: string; day: string; rotation: number; bytes: number }

const intIn = (raw: string | undefined, min: number, max: number, fallback: number): number => {
  const n = Number((raw ?? '').trim())
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/** WEBTERM_LOG_RETENTION_DAYS / WEBTERM_LOG_MAX_MB; anything out of range keeps the default. */
export function retentionFromEnv(env: NodeJS.ProcessEnv): RetentionPolicy {
  return {
    maxAgeDays: intIn(env.WEBTERM_LOG_RETENTION_DAYS, 1, MAX_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    maxBytes: intIn(env.WEBTERM_LOG_MAX_MB, 1, MAX_RETENTION_MB, DEFAULT_RETENTION_MAX_MB) * 1024 * 1024,
  }
}

/** Our log files in `dir`, oldest first (day, then rotation stamp; the live file of a day is its newest). */
export async function listLogFiles(dir: string): Promise<LogFileInfo[]> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const out: LogFileInfo[] = []
  for (const name of names) {
    const m = FILE_NAME.exec(name)
    if (!m) continue
    const bytes = await stat(join(dir, name)).then((s) => s.size, () => -1)
    if (bytes >= 0) out.push({ name, day: m[1], rotation: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER, bytes })
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.rotation - b.rotation)
}

/** Delete files older than `maxAgeDays` (by the day in the name), then the oldest until the total fits `maxBytes`. The newest file is never deleted. */
export async function purgeLogs(dir: string, policy: RetentionPolicy, now: Date = new Date()): Promise<PurgeResult> {
  const files = await listLogFiles(dir)
  const cutoff = new Date(now.getTime() - policy.maxAgeDays * DAY_MS)
  const cutoffDay = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  let total = files.reduce((n, f) => n + f.bytes, 0)
  let removedFiles = 0
  let freedBytes = 0
  for (const [i, f] of files.entries()) {
    if (i === files.length - 1) break
    if (f.day >= cutoffDay && total <= policy.maxBytes) break
    if (await unlink(join(dir, f.name)).then(() => true, () => false)) { removedFiles++; freedBytes += f.bytes; total -= f.bytes }
  }
  return { removedFiles, freedBytes, remainingBytes: total, remainingFiles: files.length - removedFiles }
}

/** Purge now and then every 24h (unref'd timer); `onPurged` is called once per run that removed something. Returns stop(). */
export function startLogRetention(dir: string, policy: RetentionPolicy, onPurged: (r: PurgeResult, p: RetentionPolicy) => void): () => void {
  const run = () => { void purgeLogs(dir, policy).then((r) => { if (r.removedFiles > 0) onPurged(r, policy) }, () => undefined) }
  run()
  const timer = setInterval(run, DAY_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface LogStats { dir: string; files: number; bytes: number; oldestDay: string | null; newestDay: string | null; policy: { maxAgeDays: number; maxBytes: number } }

/** Size and span of the log directory for `GET /api/logs/stats`. */
export async function logStats(dir: string, policy: RetentionPolicy): Promise<LogStats> {
  const files = await listLogFiles(dir)
  return { dir, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), oldestDay: files[0]?.day ?? null, newestDay: files.at(-1)?.day ?? null, policy }
}
