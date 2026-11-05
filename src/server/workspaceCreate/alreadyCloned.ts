// "Already cloned?" before a clone: compare the normalised URL with the `origin` of existing
// workspaces' folders and of the immediate children of the default projects folder and the chosen
// parent. Reads `.git/config` directly (no git process per folder), checks at most CAP folders a few
// at a time, and gives up after BUDGET_MS: a slow disk must skip the check, never hang the dialog.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeRepoUrl } from './cloneUrl'

export const ALREADY_CLONED_CAP = 200
export const ALREADY_CLONED_BUDGET_MS = 1500
const CONCURRENCY = 8

export interface Candidate { path: string; workspaceId?: string }
export interface ExistingClone { match: Candidate | null; skipped: boolean }

/** `url` of `[remote "origin"]` in `dir/.git/config`, or null (no repo, a worktree's .git file, no origin). */
export async function readOriginUrl(dir: string): Promise<string | null> {
  // Missing/unreadable config = "not a clone of anything", the common case for most folders.
  const text = await readFile(join(dir, '.git', 'config'), 'utf8').catch(() => null)
  if (!text) return null
  let inOrigin = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line)
    else if (inOrigin) {
      const m = line.match(/^url\s*=\s*(.+)$/)
      if (m) return m[1].trim().replace(/^"(.*)"$/, '$1')
    }
  }
  return null
}

/** Visible child folders; an unreadable/missing dir has none. */
async function childDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name))
}

export interface FindDeps {
  readOrigin?: (dir: string) => Promise<string | null>
  budgetMs?: number
  cap?: number
}

/** First candidate whose origin is the same repo as `url`; `skipped` when the budget ran out first. */
export async function findExistingClone(url: string, workspaces: Candidate[], scanDirs: string[], deps: FindDeps = {}): Promise<ExistingClone> {
  const want = normalizeRepoUrl(url)
  if (!want) return { match: null, skipped: false }
  const readOrigin = deps.readOrigin ?? readOriginUrl
  let stop = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const overBudget = new Promise<ExistingClone>((done) => {
    timer = setTimeout(() => done({ match: null, skipped: true }), deps.budgetMs ?? ALREADY_CLONED_BUDGET_MS)
  })
  const scan = async (): Promise<ExistingClone> => {
    const seen = new Map<string, Candidate>()
    for (const w of workspaces) if (!seen.has(resolve(w.path))) seen.set(resolve(w.path), { ...w, path: resolve(w.path) })
    for (const dirs of await Promise.all([...new Set(scanDirs)].map(childDirs))) {
      for (const d of dirs) if (!seen.has(d)) seen.set(d, { path: d })
    }
    const list = [...seen.values()].slice(0, deps.cap ?? ALREADY_CLONED_CAP)
    let next = 0
    let match: Candidate | null = null
    const worker = async (): Promise<void> => {
      while (!stop && !match && next < list.length) {
        const c = list[next++]
        const origin = await readOrigin(c.path)
        if (origin && normalizeRepoUrl(origin) === want) match ??= c
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    return { match, skipped: false }
  }
  try {
    return await Promise.race([scan(), overBudget])
  } finally {
    stop = true
    clearTimeout(timer)
  }
}
