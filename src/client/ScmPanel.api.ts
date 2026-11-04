// Same-origin client of `/api/git/scm/*` (src/server/gitScm.route.ts). The browser's own fetch
// metadata (`Sec-Fetch-Site: same-origin`) is what lets the human-only POSTs through. Every failure
// throws a `ScmApiError` naming the operation, the server's reason, and the full error body.
import { OUTBOX_PATH } from '../server/outbox/outbox.types'
import {
  SCM_COMMIT_PATH, SCM_HUNKS_PATH, SCM_MESSAGE_PATH, SCM_PR_PATH, SCM_PUSH_PATH, SCM_REPORT_PATH, SCM_STAGE_PATH,
  SCM_STATUS_PATH, SCM_UNSTAGE_PATH, type ScmHunk, type ScmReport, type ScmStatus,
} from '../server/gitScm.types'
import { tokenQuery } from './api'

export class ScmApiError extends Error {
  constructor(message: string, readonly body: Record<string, unknown>) {
    super(message)
  }
}

function url(path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString()
  return `${path}?${[q, tokenQuery()].filter(Boolean).join('&')}`
}

async function call<T>(op: string, input: string, body?: unknown): Promise<T> {
  const res = await fetch(input, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ScmApiError(`${op}: ${String(out.message ?? out.error ?? `HTTP ${res.status}`)}`, out)
  return out as T
}

export const fetchStatus = (root: string) => call<ScmStatus>('Load source control status', url(SCM_STATUS_PATH, { root }))
export const fetchHunks = (root: string, path: string, area: 'staged' | 'unstaged') =>
  call<{ hunks: ScmHunk[] }>(`Load hunks of ${path}`, url(SCM_HUNKS_PATH, { root, path, area })).then((r) => r.hunks)
export const fetchReport = (root: string) => call<{ report: ScmReport | null }>('Load pre-push report', url(SCM_REPORT_PATH, { root })).then((r) => r.report)

export const stagePath = (root: string, path: string, hunkId?: string) => call(`Stage ${path}`, url(SCM_STAGE_PATH), { root, path, hunkId })
export const unstagePath = (root: string, path: string, hunkId?: string) => call(`Unstage ${path}`, url(SCM_UNSTAGE_PATH), { root, path, hunkId })
export const generateMessage = (root: string) => call<{ message: string; problem: string | null }>('Generate commit message', url(SCM_MESSAGE_PATH), { root })
export const commitStaged = (root: string, message: string) => call<{ ok: true; head: string }>('Commit', url(SCM_COMMIT_PATH), { root, message })
export const runReport = (root: string) => call<{ report: ScmReport }>('Run pre-push checks', url(SCM_REPORT_PATH), { root }).then((r) => r.report)
export const pushBranch = (root: string, acknowledge: boolean) => call<{ ok: true; output: string }>('Push', url(SCM_PUSH_PATH), { root, acknowledge })
export const createPr = (root: string) => call<{ ok: true; url: string }>('Create pull request', url(SCM_PR_PATH), { root })

/** "Fix with agent": the hook output goes to the wired agent through the outbox, once per commit attempt. */
export const sendFixToAgent = (agentId: string, prompt: string, attempt: string) =>
  call('Send to agent', url(OUTBOX_PATH), { to: agentId, body: prompt, operationId: `scm-fix:${agentId}:${attempt}` })
