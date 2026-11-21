import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { logStats, purgeLogs, retentionFromEnv } from './logRetention'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const mk = (files: Record<string, number>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-logs-'))
  dirs.push(dir)
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), 'x'.repeat(bytes))
  writeFileSync(join(dir, 'notes.txt'), 'not ours')
  return dir
}
const left = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.log')).sort()
const NOW = new Date(2026, 10, 21, 12)

describe('purgeLogs', () => {
  it('deletes files older than the age limit and keeps foreign files', async () => {
    const dir = mk({ 'webterm-2026-11-01.log': 10, 'webterm-2026-11-07.log': 10, 'webterm-2026-11-20.log': 10 })
    const r = await purgeLogs(dir, { maxAgeDays: 14, maxBytes: 1e9 }, NOW)
    expect(left(dir)).toEqual(['webterm-2026-11-07.log', 'webterm-2026-11-20.log'])
    expect(r).toMatchObject({ removedFiles: 1, freedBytes: 10, remainingFiles: 2 })
    expect(readdirSync(dir)).toContain('notes.txt')
  })

  it('deletes the oldest until the total fits, never the newest file', async () => {
    const dir = mk({ 'webterm-2026-11-18.log': 400, 'webterm-2026-11-19.log': 400, 'webterm-2026-11-20.log': 400 })
    const r = await purgeLogs(dir, { maxAgeDays: 14, maxBytes: 500 }, NOW)
    expect(left(dir)).toEqual(['webterm-2026-11-20.log'])
    expect(r.remainingBytes).toBe(400)
    const only = mk({ 'webterm-2026-11-20.log': 900 })
    await purgeLogs(only, { maxAgeDays: 14, maxBytes: 10 }, NOW)
    expect(left(only)).toEqual(['webterm-2026-11-20.log'])
  })

  it('orders rotated files of one day before the live file', async () => {
    const dir = mk({ 'webterm-2026-11-20.1700000000000.log': 300, 'webterm-2026-11-20.log': 300 })
    await purgeLogs(dir, { maxAgeDays: 14, maxBytes: 400 }, NOW)
    expect(left(dir)).toEqual(['webterm-2026-11-20.log'])
  })

  it('does nothing for a missing directory', async () => {
    await expect(purgeLogs(join(tmpdir(), 'wt-logs-missing'), { maxAgeDays: 1, maxBytes: 1 }, NOW)).resolves.toMatchObject({ removedFiles: 0 })
  })
})

describe('retention config and stats', () => {
  it('defaults to 14 days / 200 MB and ignores out-of-range env', () => {
    expect(retentionFromEnv({})).toEqual({ maxAgeDays: 14, maxBytes: 200 * 1024 * 1024 })
    expect(retentionFromEnv({ WEBTERM_LOG_RETENTION_DAYS: '3', WEBTERM_LOG_MAX_MB: '5' })).toEqual({ maxAgeDays: 3, maxBytes: 5 * 1024 * 1024 })
    expect(retentionFromEnv({ WEBTERM_LOG_RETENTION_DAYS: '0', WEBTERM_LOG_MAX_MB: 'abc' })).toEqual({ maxAgeDays: 14, maxBytes: 200 * 1024 * 1024 })
  })

  it('reports size and span', async () => {
    const dir = mk({ 'webterm-2026-11-19.log': 5, 'webterm-2026-11-20.log': 7 })
    expect(await logStats(dir, retentionFromEnv({}))).toMatchObject({ files: 2, bytes: 12, oldestDay: '2026-11-19', newestDay: '2026-11-20' })
  })
})
