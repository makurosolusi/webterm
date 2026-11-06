// Same-origin client of `/api/git/diff*` (src/server/gitDiff.route.ts). Token rides the query like
// fsClient. Every failure throws one Error naming the operation and the server's reason.
import { GIT_DIFF_PATH, GIT_DIFF_UNDO_PATH, type GitDiffList, type GitFileDiff } from '../server/gitDiff.types'

function url(path: string, params: Record<string, string>): string {
  return `${path}?${new URLSearchParams(params).toString()}`
}

async function call<T>(op: string, input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string }
  if (!res.ok) throw new Error(`${op}: ${body.message ?? body.error ?? `HTTP ${res.status}`}`)
  return body
}

export function fetchDiffList(root: string, offset = 0): Promise<GitDiffList> {
  return call('Load changes', url(GIT_DIFF_PATH, { root, offset: String(offset) }))
}

export function fetchFileDiff(root: string, path: string): Promise<GitFileDiff> {
  return call(`Load diff of ${path}`, url(GIT_DIFF_PATH, { root, path }))
}

export async function undoHunk(root: string, path: string, hunkId: string): Promise<void> {
  await call(`Undo hunk in ${path}`, url(GIT_DIFF_UNDO_PATH, {}), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, path, hunkId }),
  })
}
