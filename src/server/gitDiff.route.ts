// HTTP binding of `gitDiff.ts`, same `(path, method, ...) => {status, body} | null` contract as
// `gitInfoRoute`: null = not this route, so api.ts keeps falling through to its 404.
//
//   GET  /api/git/diff?root=<dir>[&offset=&limit=]  changed files, paginated   (capability git.diff, R0)
//   GET  /api/git/diff?root=<dir>&path=<rel>        both sides + hunks of one file
//   POST /api/git/diff/undo {root, path, hunkId}    reverse-apply one hunk (human UI only: root token)
import { GIT_DIFF_PAGE_DEFAULT, GIT_DIFF_PAGE_MAX, GIT_DIFF_PATH, GIT_DIFF_UNDO_PATH, type GitDiffList } from './gitDiff.types'
import { fileDiff, GitDiffError, listChanges, repoRootOf, sniffUntracked, undoHunk } from './gitDiff'

type Result = { status: number; body: unknown } | null

const HTTP_STATUS: Record<GitDiffError['code'], number> = {
  not_a_repo: 400, bad_path: 400, not_changed: 404, sensitive: 403, undo_unsupported: 400, stale: 409, conflict: 409, git_failed: 500,
}

const fail = (e: unknown): Result => {
  if (e instanceof GitDiffError) return { status: HTTP_STATUS[e.code], body: { error: e.code, message: e.message } }
  throw e // unexpected: api.ts's net logs it and answers 500 without leaking paths
}

function intParam(v: string | null, dflt: number, max: number): number | null {
  if (v === null || v === '') return dflt
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null
}

export async function gitDiffRoute(path: string, method: string, query: URLSearchParams, body: () => Promise<string>): Promise<Result> {
  if (path === GIT_DIFF_PATH && method === 'GET') {
    const rootParam = query.get('root')
    if (!rootParam) return { status: 400, body: { error: 'bad_request', message: 'root is required' } }
    const offset = intParam(query.get('offset'), 0, Number.MAX_SAFE_INTEGER)
    const limit = intParam(query.get('limit'), GIT_DIFF_PAGE_DEFAULT, GIT_DIFF_PAGE_MAX)
    if (offset === null || limit === null || limit === 0) return { status: 400, body: { error: 'bad_request', message: `offset >= 0, 1 <= limit <= ${GIT_DIFF_PAGE_MAX}` } }
    try {
      const root = await repoRootOf(rootParam)
      const file = query.get('path')
      if (file !== null) return { status: 200, body: await fileDiff(root, file) }
      const all = await listChanges(root)
      const end = offset + limit
      const res: GitDiffList = { root, files: await sniffUntracked(root, all.slice(offset, end)), total: all.length, nextOffset: end < all.length ? end : null }
      return { status: 200, body: res }
    } catch (e) {
      return fail(e)
    }
  }
  if (path === GIT_DIFF_UNDO_PATH && method === 'POST') {
    let req: { root?: unknown; path?: unknown; hunkId?: unknown }
    try {
      req = JSON.parse(await body())
    } catch {
      return { status: 400, body: { error: 'bad_request', message: 'bad json' } }
    }
    if (!req || typeof req.root !== 'string' || typeof req.hunkId !== 'string' || !req.hunkId) {
      return { status: 400, body: { error: 'bad_request', message: 'root, path and hunkId are required' } }
    }
    try {
      await undoHunk(await repoRootOf(req.root), req.path as string, req.hunkId)
      return { status: 200, body: { ok: true } }
    } catch (e) {
      return fail(e)
    }
  }
  return null
}
