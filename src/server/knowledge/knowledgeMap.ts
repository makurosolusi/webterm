// Lite Map: import in-degree, FTS rebuild, `kb.search` and `kb.map` queries over knowledge.db.
import type { Database } from 'bun:sqlite'
import { posix } from 'node:path'
import type { KnowledgeHit, KnowledgeModule } from '../central/contracts/knowledge.types'
import { allRows, execWrite } from '../ledger/ledgerCore'
import type { DocSection } from './knowledgeDocs'

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const MAX_QUERY_TOKENS = 8
const MAX_EXPORT_ROW_CHARS = 2000
const SNIPPET_TOKENS = 12
const TOP_FILES = 3
const SUMMARY_EXPORTS = 3
const MAX_SUMMARY_CHARS = 200
/** Default and hard cap of `kb.map` / `kb.search` result sizes. */
export const KB_MAP_DEFAULT = 30
export const KB_LIST_MAX = 100

/** Resolves a relative import specifier to an indexed path (TS `.js`-for-`.ts` style included), else null. */
export function resolveImport(from: string, spec: string, paths: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  const bare = base.replace(/\.(m|c)?jsx?$/, '')
  const candidates = [base, ...SOURCE_EXT.map((e) => bare + e), ...SOURCE_EXT.map((e) => `${base}/index${e}`)]
  return candidates.find((c) => paths.has(c)) ?? null
}

/** Recomputes `in_degree` (number of distinct importers) for every file of a project. */
export function computeInDegree(db: Database, projectId: string): void {
  const rows = allRows(db, 'SELECT path, imports_json FROM kb_file WHERE project_id = ?', projectId)
  const paths = new Set(rows.map((r) => String(r.path)))
  const degree = new Map<string, number>()
  for (const r of rows) {
    const from = String(r.path)
    const targets = new Set((JSON.parse(String(r.imports_json)) as string[]).map((s) => resolveImport(from, s, paths)))
    for (const t of targets) if (t && t !== from) degree.set(t, (degree.get(t) ?? 0) + 1)
  }
  execWrite(db, 'UPDATE kb_file SET in_degree = 0 WHERE project_id = ?', projectId)
  for (const [path, n] of degree) execWrite(db, 'UPDATE kb_file SET in_degree = ? WHERE project_id = ? AND path = ?', n, projectId, path)
}

/** Replaces the FTS rows of a project: doc sections plus one `exports` row per source file. */
export function rebuildFts(db: Database, projectId: string, docs: readonly DocSection[]): void {
  execWrite(db, 'DELETE FROM kb_doc WHERE project_id = ?', projectId)
  for (const d of docs) execWrite(db, 'INSERT INTO kb_doc (project_id, path, heading, text) VALUES (?,?,?,?)', projectId, d.path, d.heading, d.text)
  for (const r of allRows(db, "SELECT path, exports_json FROM kb_file WHERE project_id = ? AND exports_json != '[]'", projectId)) {
    const names = (JSON.parse(String(r.exports_json)) as string[]).join(' ').slice(0, MAX_EXPORT_ROW_CHARS)
    execWrite(db, 'INSERT INTO kb_doc (project_id, path, heading, text) VALUES (?,?,?,?)', projectId, String(r.path), 'exports', names)
  }
}

/** Turns free text into a safe FTS5 query (quoted tokens, implicit AND); null when nothing searchable. */
export function ftsQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_QUERY_TOKENS)
  return tokens?.length ? tokens.map((t) => `"${t}"`).join(' ') : null
}

/** BM25-ranked hits over docs and export names of one project. */
export function searchKb(db: Database, projectId: string, query: string, limit: number): KnowledgeHit[] {
  const match = ftsQuery(query)
  if (!match) return []
  const rows = allRows(db, `SELECT path, heading, snippet(kb_doc, 3, '[', ']', '…', ${SNIPPET_TOKENS}) AS snip, bm25(kb_doc) AS score
    FROM kb_doc WHERE kb_doc MATCH ? AND project_id = ? ORDER BY score LIMIT ?`, match, projectId, Math.min(Math.max(limit, 1), KB_LIST_MAX))
  return rows.map((r) => ({ path: String(r.path), title: String(r.heading), snippet: String(r.snip), score: -Number(r.score) }))
}

/** Directory-level module map ordered by total in-degree (importance), then name. */
export function moduleMap(db: Database, projectId: string, limit = KB_MAP_DEFAULT): KnowledgeModule[] {
  const dirs = new Map<string, Array<{ path: string; inDegree: number; exports: string[] }>>()
  for (const r of allRows(db, 'SELECT path, in_degree, exports_json FROM kb_file WHERE project_id = ?', projectId)) {
    const path = String(r.path)
    const dir = posix.dirname(path)
    const list = dirs.get(dir) ?? []
    list.push({ path, inDegree: Number(r.in_degree), exports: JSON.parse(String(r.exports_json)) as string[] })
    dirs.set(dir, list)
  }
  const modules = [...dirs].map(([dir, files]) => {
    const top = [...files].sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path)).slice(0, TOP_FILES).filter((f) => f.inDegree > 0)
    const parts = top.map((f) => `${posix.basename(f.path)}(in ${f.inDegree}${f.exports.length ? `: ${f.exports.slice(0, SUMMARY_EXPORTS).join(',')}` : ''})`)
    const summary = `${files.length} files${parts.length ? `; ${parts.join(' ')}` : ''}`.slice(0, MAX_SUMMARY_CHARS)
    return { dir, summary, inDegree: files.reduce((sum, f) => sum + f.inDegree, 0) }
  })
  return modules.sort((a, b) => b.inDegree - a.inDegree || a.dir.localeCompare(b.dir)).slice(0, Math.min(Math.max(limit, 1), KB_LIST_MAX))
}
