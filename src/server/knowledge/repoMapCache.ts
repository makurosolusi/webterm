// Incremental symbol cache for the repo-map: `repomap.db`, disposable like knowledge.db (a schema
// change drops and rebuilds it, no migration). A file is re-read only when its signature changed:
// the git blob sha for clean tracked files, mtime+size for dirty or untracked ones.
import { Database } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { allRows, execWrite, getRow } from '../ledger/ledgerCore'
import { realPathOf } from '../orchestrator/safePath'
import { readGitState } from './knowledgeFresh'
import { listFiles, readTextSafe } from './knowledgeScan'
import { KB_YIELD_EVERY, KnowledgeError, inTransaction } from './knowledgeStore'
import { type RenderedMap, rankFiles, renderMap } from './repoMapRank'
import { type FileSymbols, extractSymbols, repoLangOf } from './repoMapSymbols'

export const REPO_MAP_SCHEMA_VERSION = 1
/** Source files considered per repo; the rest are left out of the graph. */
// ponytail: hard cap instead of streaming the graph; raise or shard when a monorepo needs it.
export const REPO_MAP_MAX_FILES = 5000

/** Opens (creating or rebuilding) the repo-map cache; `:memory:` works for tests. */
export function openRepoMapDb(file: string): Database {
  const db = new Database(file)
  const version = Number(getRow(db, 'PRAGMA user_version')?.user_version ?? 0)
  if (version !== 0 && version !== REPO_MAP_SCHEMA_VERSION) db.exec('DROP TABLE IF EXISTS repomap_file')
  db.exec(`CREATE TABLE IF NOT EXISTS repomap_file (
    root TEXT NOT NULL, path TEXT NOT NULL, sig TEXT NOT NULL, symbols_json TEXT NOT NULL, PRIMARY KEY (root, path))`)
  db.exec(`PRAGMA user_version = ${REPO_MAP_SCHEMA_VERSION}`)
  return db
}

export interface RepoMapResult extends RenderedMap { root: string; parsed: number; cached: number }

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function statSig(abs: string): string | null {
  try { const st = lstatSync(abs); return st.isFile() ? `m:${st.mtimeMs}:${st.size}` : null } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new KnowledgeError('stat_failed', `repo-map stat failed: ${(err as Error).message}`)
  }
}

/** Refreshes the cache for `root` (changed files only) and returns every file's symbols. */
export async function refreshSymbols(db: Database, root: string): Promise<{ files: Map<string, FileSymbols>; parsed: number; cached: number }> {
  const listed = await listFiles(root)
  if (listed === null) throw new KnowledgeError('not_git', `repo-map needs a git repository: ${root}`)
  const real = realPathOf(root)
  const dirty = new Set((await readGitState(root)).dirty)
  const stored = new Map(allRows(db, 'SELECT path, sig, symbols_json FROM repomap_file WHERE root = ?', real).map((r) => [String(r.path), { sig: String(r.sig), json: String(r.symbols_json) }]))
  const files = new Map<string, FileSymbols>()
  const writes: Array<[string, string, string]> = []
  let parsed = 0
  let n = 0
  for (const f of listed) {
    const lang = repoLangOf(f.path)
    if (!lang || files.size >= REPO_MAP_MAX_FILES) continue
    const sig = f.tracked && !dirty.has(f.path) ? f.sha : statSig(join(root, f.path))
    if (!sig) continue
    const old = stored.get(f.path)
    if (old && old.sig === sig) files.set(f.path, JSON.parse(old.json) as FileSymbols)
    else {
      const text = readTextSafe(root, f.path)
      const sym = text === null ? { defs: [], refs: {} } : extractSymbols(text, lang)
      files.set(f.path, sym)
      writes.push([f.path, sig, JSON.stringify(sym)])
      parsed++
    }
    if (++n % KB_YIELD_EVERY === 0) await tick()
  }
  const gone = [...stored.keys()].filter((p) => !files.has(p))
  if (writes.length || gone.length) inTransaction(db, 'repo-map write', () => {
    for (const w of writes) execWrite(db, 'INSERT OR REPLACE INTO repomap_file (root, path, sig, symbols_json) VALUES (?,?,?,?)', real, ...w)
    for (const p of gone) execWrite(db, 'DELETE FROM repomap_file WHERE root = ? AND path = ?', real, p)
  })
  return { files, parsed, cached: files.size - parsed }
}

/** Ranked, size-bounded repo-map of `root`; `focus` = repo-relative files the session is working on. */
export async function buildRepoMap(db: Database, root: string, opts: { focus?: readonly string[]; maxTokens?: number } = {}): Promise<RepoMapResult> {
  const { files, parsed, cached } = await refreshSymbols(db, root)
  return { root: realPathOf(root), parsed, cached, ...renderMap(rankFiles(files, opts.focus), opts.maxTokens) }
}
