/**
 * `tool_cache` (ledger v19, PLAN/rnd/03 §3): results of idempotent R0 reads keyed by (tool, normalised
 * args) and served only while the source version is unchanged. Deterministic, never semantic: a
 * different version is a miss, so a stale answer needs a version bump the source did not make.
 * Bounded: past `TOOL_CACHE_MAX` rows the least recently used are dropped on write.
 */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { execWrite, getRow } from '../ledger/ledgerCore'

/**
 * Read-only tools whose output is a pure function of (args, source version). project.list is left out on
 * purpose: a version covering every ledger table it reads costs as much as the query itself.
 */
export const TOOL_CACHE_TOOLS = ['repo.map', 'git.diff'] as const
export type CacheableTool = (typeof TOOL_CACHE_TOOLS)[number]
export const TOOL_CACHE_MAX = 500

/** JSON with object keys sorted at every level, so `{a,b}` and `{b,a}` share a key. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const toolCacheKey = (tool: string, args: unknown): string => createHash('sha256').update(`${tool}\0${stableJson(args)}`).digest('hex')

export interface ToolCacheRequest { tool: CacheableTool; args: unknown; version: string }

/**
 * Cached result when `version` matches, else `compute()` stored under the new version. `keep` decides
 * whether a fresh result is stored (default: always); errors should not be, so a retry recomputes.
 */
export async function cachedToolRead<T>(db: Database, req: ToolCacheRequest, compute: () => T | Promise<T>, now: number, keep: (value: T) => boolean = () => true): Promise<{ value: T; hit: boolean }> {
  if (!(TOOL_CACHE_TOOLS as readonly string[]).includes(req.tool)) throw new Error(`tool_cache: ${req.tool} is not a cacheable R0 read`)
  const key = toolCacheKey(req.tool, req.args)
  const row = getRow(db, 'SELECT version, result_json FROM tool_cache WHERE key = ?', key)
  if (row && row['version'] === req.version) {
    execWrite(db, 'UPDATE tool_cache SET last_used_at = ? WHERE key = ?', now, key)
    return { value: JSON.parse(String(row['result_json'])) as T, hit: true }
  }
  const value = await compute()
  if (!keep(value)) return { value, hit: false }
  execWrite(db, 'INSERT OR REPLACE INTO tool_cache (key, tool, version, result_json, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
    key, req.tool, req.version, JSON.stringify(value), now, now)
  const n = Number(getRow(db, 'SELECT COUNT(*) AS n FROM tool_cache')?.['n'] ?? 0)
  if (n > TOOL_CACHE_MAX) execWrite(db, 'DELETE FROM tool_cache WHERE key IN (SELECT key FROM tool_cache ORDER BY last_used_at ASC LIMIT ?)', n - TOOL_CACHE_MAX)
  return { value, hit: false }
}
