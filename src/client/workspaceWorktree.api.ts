// Same-origin client of `/api/workspace-worktree/*` (src/server/workspaceWorktree.route.ts), in the
// shape of ScmPanel.api.ts: the browser's `Sec-Fetch-Site: same-origin` lets the UI-only POSTs in.
import type { CreatedWorktree, RemoveWorktreeResult, WorktreeStatus } from '../server/workspaceWorktree'
import { WORKTREE_CREATE_PATH, WORKTREE_REMOVE_PATH, WORKTREE_STATUS_PATH } from '../server/workspaceWorktree.types'

export type { CreatedWorktree, WorktreeStatus }

export class WorktreeApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message)
  }
}

function url(path: string, params: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams(params).toString()}`
}

async function call<T>(op: string, input: string, body?: unknown): Promise<T> {
  const res = await fetch(input, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new WorktreeApiError(`${op}: ${String(out.message ?? out.error ?? `HTTP ${res.status}`)}`, res.status, out)
  return out as T
}

export const createWorktree = (input: { repo: string; title: string; branch?: string; base?: string; runSetup: boolean }) =>
  call<CreatedWorktree>('Create worktree', url(WORKTREE_CREATE_PATH), input)

export const fetchWorktreeStatus = (path: string) => call<WorktreeStatus>('Load worktree status', url(WORKTREE_STATUS_PATH, { path }))

const removeWorktree = (path: string, confirm: boolean) =>
  call<Extract<RemoveWorktreeResult, { removed: true }>>('Remove worktree', url(WORKTREE_REMOVE_PATH), { path, confirm })

/** Confirmation text for removing a worktree; names what would be lost and that the branch stays. */
export function removeWorktreeMessage(s: WorktreeStatus): string {
  const risks = [
    s.dirtyCount ? `${s.dirtyCount} uncommitted change${s.dirtyCount === 1 ? '' : 's'} (will be lost)` : '',
    s.unpushed ? `${s.unpushed} commit${s.unpushed === 1 ? '' : 's'} not on any other branch or remote` : '',
  ].filter(Boolean)
  const branch = s.branch ? `Branch “${s.branch}” is kept.` : 'HEAD is detached.'
  return (
    `Also remove the worktree folder ${s.path}? ${branch}` +
    (risks.length ? `\n\nWarning: it has ${risks.join(' and ')}.` : '')
  )
}

/**
 * Before deleting a workspace: when its cwd is a webterm worktree, ask whether to remove it too.
 * Returns what happened; `'kept'` when the user declines or the cwd is not a worktree. Never removes
 * dirty work without the user having seen the warning in the same confirm.
 */
export async function offerRemoveWorktree(cwd: string | undefined, ask: (message: string) => boolean = window.confirm): Promise<'removed' | 'kept'> {
  if (!cwd) return 'kept'
  // An unreadable status must not block deleting the workspace: that only drops webterm's row and
  // never touches files, so the worktree (if any) simply stays on disk.
  const status = await fetchWorktreeStatus(cwd).catch((err: unknown) => {
    console.warn(`[webterm] worktree status before delete failed, keeping any worktree: ${err instanceof Error ? err.message : String(err)}`)
    return { managed: false } as WorktreeStatus
  })
  if (!status.managed || !status.path) return 'kept'
  if (!ask(removeWorktreeMessage(status))) return 'kept'
  await removeWorktree(status.path, (status.dirtyCount ?? 0) > 0 || (status.unpushed ?? 0) > 0)
  return 'removed'
}
