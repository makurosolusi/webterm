// Freshness and incremental indexing (RND/27 4.6): compare git head + dirty hash with the stored
// state, rescan only changed files, yield to the event loop in chunks. No watcher, no git hook.
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { realPathOf } from '../orchestrator/safePath'
import type { KnowledgeAsOf } from '../central/contracts/knowledge.types'
import { execWrite } from '../ledger/ledgerCore'
import { collectDocs } from './knowledgeDocs'
import { computeInDegree, rebuildFts } from './knowledgeMap'
import { git, langOf, listFiles, scanSource } from './knowledgeScan'
import { KB_MAX_FILES, KB_YIELD_EVERY, type KbLevel, getKbProject, inTransaction, putKbProject, storedShas } from './knowledgeStore'

export interface GitState {
  isGit: boolean
  head: string | null
  commitTs: number | null
  branch: string | null
  /** Repo-relative paths with uncommitted changes (including untracked). */
  dirty: string[]
  dirtyHash: string
}

const NO_GIT_HASH = 'no-git'

function parseStatus(raw: string): { branch: string | null; dirty: string[]; lines: string[] } {
  const parts = raw.split('\0')
  let branch: string | null = null
  const dirty: string[] = []
  const lines: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.startsWith('## ')) { branch = entry.slice(3).replace(/\.\.\..*$/, '').replace(/ .*$/, '') || null; continue }
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    if (xy.includes('R') || xy.includes('C')) i++ // rename/copy entries carry the origin path as a separate field
    dirty.push(entry.slice(3))
    lines.push(`${xy} ${entry.slice(3)}`)
  }
  return { branch, dirty, lines }
}

/** Current git state of a root; `isGit` false when it is not a repository. */
export async function readGitState(root: string): Promise<GitState> {
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
  if (status === null) return { isGit: false, head: null, commitTs: null, branch: null, dirty: [], dirtyHash: NO_GIT_HASH }
  const { branch, dirty, lines } = parseStatus(status)
  const head = (await git(root, ['rev-parse', 'HEAD']))?.trim() || null
  const ts = Number((await git(root, ['log', '-1', '--format=%ct']))?.trim())
  const hash = createHash('sha1')
  // mtime+size make a second edit of an already-dirty file change the hash (status text alone would not).
  for (const [i, path] of dirty.entries()) {
    let sig = 'gone'
    try { const st = lstatSync(join(root, path)); sig = `${st.mtimeMs}:${st.size}` } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    hash.update(`${lines[i]} ${sig}\n`)
  }
  return { isGit: true, head, commitTs: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null, branch, dirty, dirtyHash: hash.digest('hex') }
}

export interface Freshness { stale: boolean; reason: string | null; state: GitState }

/** Compares the stored index with the live git state; cheap (one status call). */
export async function checkFreshness(db: Database, projectId: string, root: string): Promise<Freshness> {
  const state = await readGitState(root)
  const stored = getKbProject(db, projectId)
  const reason = !state.isGit ? 'not_git' : !stored ? 'never_indexed' : stored.root !== realPathOf(root) ? 'root_changed'
    : stored.headSha !== state.head ? 'head_changed' : stored.dirtyHash !== state.dirtyHash ? 'dirty_changed' : null
  return { stale: reason !== null, reason, state }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Re-indexes a project incrementally: only new, changed, or dirty files are re-read; above `maxFiles` the index is `light`. */
export async function refreshIndex(db: Database, projectId: string, root: string, now: number, maxFiles = KB_MAX_FILES): Promise<void> {
  const state = await readGitState(root)
  const real = realPathOf(root)
  const listed = state.isGit ? await listFiles(root) : null
  const level: KbLevel = (listed?.length ?? 0) > maxFiles ? 'light' : 'full'
  const prior = storedShas(db, projectId)
  // A light index holds no exports/imports, so nothing in it can be reused for a full one.
  const wasLight = getKbProject(db, projectId)?.level === 'light'
  const dirty = new Set(state.dirty)
  const rows: Array<[string, string, number, string, string, string]> = []
  let n = 0
  for (const f of listed ?? []) {
    const lang = langOf(f.path)
    const old = prior.get(f.path)
    const reuse = old && !wasLight && old.sha === f.sha && f.tracked && !dirty.has(f.path)
    if (level === 'light' || lang === 'other' || lang === 'md') rows.push([f.path, f.sha, old?.bytes ?? 0, lang, '[]', '[]'])
    else if (reuse) rows.push([f.path, f.sha, old.bytes, lang, old.exports, old.imports])
    else {
      const s = scanSource(root, f.path, lang)
      rows.push([f.path, f.sha, s.bytes, lang, JSON.stringify(s.exports), JSON.stringify(s.imports)])
    }
    if (++n % KB_YIELD_EVERY === 0) await tick()
  }
  const docs = collectDocs(root)
  inTransaction(db, 'index write', () => {
    execWrite(db, 'DELETE FROM kb_file WHERE project_id = ?', projectId)
    for (const r of rows) execWrite(db, 'INSERT INTO kb_file (project_id, path, sha, bytes, lang, exports_json, imports_json) VALUES (?,?,?,?,?,?,?)', projectId, ...r)
    computeInDegree(db, projectId)
    rebuildFts(db, projectId, docs)
    putKbProject(db, { projectId, root: real, headSha: state.head, dirtyHash: state.dirtyHash, commitTs: state.commitTs, indexedAt: now, level, fileCount: rows.length }, state.isGit ? 'git' : 'dir')
  })
}

export interface FreshAnswer { asOf: KnowledgeAsOf; stale: boolean; reason: string | null }

/** Ensures the index matches git (re-indexing when `refresh`), and reports asOf + stale honestly. */
export async function ensureFresh(db: Database, projectId: string, root: string, now: number, refresh = true): Promise<FreshAnswer> {
  let fresh = await checkFreshness(db, projectId, root)
  if (fresh.stale && refresh) {
    await refreshIndex(db, projectId, root, now)
    fresh = await checkFreshness(db, projectId, root)
  }
  const stored = getKbProject(db, projectId)
  const sha = stored?.headSha ?? fresh.state.head
  return { asOf: { at: stored?.indexedAt ?? now, ...(sha ? { sha } : {}) }, stale: fresh.stale, reason: fresh.reason }
}
