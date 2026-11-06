// Client side of /api/prreview (src/server/prreview/prreview.api.ts): request helper and product text.
import type { DraftView, PrReviewJob } from '../../server/prreview/prreview.service'

export type { DraftView, PrReviewJob }
export const PRREVIEW_API = '/api/prreview'
export const PRREVIEW_POLL_MS = 3000

export const PRREVIEW_TEXT = {
  title: 'Pull request review',
  intro: 'Claude Code reviews the PR head in a fresh read-only worktree. Findings land in the Inbox as a draft; nothing is posted to GitHub until you click Post review.',
  prLabel: 'Pull request number',
  review: (pr: string) => (pr ? `Review PR #${pr}` : 'Review PR'),
  noGh: 'Install the GitHub CLI (gh) to review pull requests.',
  post: 'Post review',
  posted: (url: string) => `Review posted: ${url}`,
  status: { running: 'Reviewing…', drafted: 'Draft in the Inbox', clean: 'No findings', failed: 'Failed' },
  draft: (d: DraftView) => `PR #${d.pr}: ${d.findings} finding${d.findings === 1 ? '' : 's'}, ${d.inline} inline`,
} as const

/** JSON request; a non-2xx answer throws with the server's message. */
export async function prReviewRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const e = (out ?? {}) as { message?: string; error?: string }
    throw new Error(e.message ?? e.error ?? `${method} ${path} failed (${res.status})`)
  }
  return out as T
}
