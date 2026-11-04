// Recently opened files + recency-first ranking for global Quick Open (⌘P). Ranking imitates Orca
// `src/renderer/src/components/quick-open-history-ranking.ts:10-35`: history entries that still
// exist and match go first, most recent first; the rest follow by fuzzy score. History is
// absolute paths per browser (localStorage), newest first.
import { fuzzyFilter } from './fuzzy'

export const RECENT_FILES_KEY = 'webterm.quickOpen.recent'
export const RECENT_FILES_MAX = 50

export function loadRecentFiles(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string').slice(0, RECENT_FILES_MAX) : []
  } catch (e) {
    console.warn('quick open: recent files unreadable, starting empty', e instanceof Error ? e.name : 'unknown')
    return []
  }
}

/** Move `absPath` to the front of the history. */
export function recordRecentFile(absPath: string): void {
  const next = [absPath, ...loadRecentFiles().filter((p) => p !== absPath)].slice(0, RECENT_FILES_MAX)
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next))
  } catch (e) {
    console.warn('quick open: could not persist recent files', e instanceof Error ? e.name : 'unknown')
  }
}

/** `root`-relative form of the history entries under `root` (newest first). */
export function recentUnder(root: string, history: readonly string[]): string[] {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return history.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}

/** Files (relative) ranked for `query`: matching recent ones first in recency order, then fuzzy. */
export function rankWithHistory(query: string, files: readonly string[], recent: readonly string[], limit: number): string[] {
  const available = new Set(files)
  const eligible = recent.filter((p) => available.has(p))
  const recentHits = query ? eligible.filter((p) => fuzzyFilter(query, [p], 1).length > 0) : eligible
  const taken = new Set(recentHits)
  return [...recentHits, ...fuzzyFilter(query, files, limit + taken.size).filter((p) => !taken.has(p))].slice(0, limit)
}
