import { useEffect, useState } from 'react'
import { fetchWorktreeStatus, type WorktreeStatus } from './workspaceWorktree.api'

// ponytail: one status request per worktree-capable workspace every 15 s; batch server-side if tab counts grow.
const POLL_MS = 15_000

/** Worktree status per workspace id (only ids whose cwd is a webterm worktree end up `managed`). */
export function useWorktreeStatuses(workspaces: { id: string; cwd?: string }[]): Record<string, WorktreeStatus> {
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus>>({})
  const key = workspaces.map((w) => `${w.id}\0${w.cwd ?? ''}`).join('\n')
  useEffect(() => {
    const targets = workspaces.filter((w): w is { id: string; cwd: string } => Boolean(w.cwd))
    if (targets.length === 0) { setStatuses({}); return }
    let alive = true
    const load = async () => {
      const entries = await Promise.all(targets.map(async (w) => {
        try {
          return [w.id, await fetchWorktreeStatus(w.cwd)] as const
        } catch (err) {
          console.warn(`[webterm] worktree status for workspace ${w.id} failed: ${err instanceof Error ? err.message : String(err)}`)
          return [w.id, { managed: false }] as const
        }
      }))
      if (alive) setStatuses(Object.fromEntries(entries))
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => { alive = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content identity of `workspaces`
  }, [key])
  return statuses
}

/** One-line description of a worktree's state, for tooltips and the badge's accessible name. */
export function worktreeSummary(s: WorktreeStatus): string {
  const dirty = s.dirtyCount ?? 0
  return `Worktree branch ${s.branch ?? '(detached)'}` +
    (dirty ? `, ${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : ', clean') +
    (s.unpushed ? `, ${s.unpushed} unpushed commit${s.unpushed === 1 ? '' : 's'}` : '')
}

/** Branch + dirty marker for a webterm worktree; renders nothing for a plain folder. */
export function WorkspaceWorktreeBadge({ status }: { status?: WorktreeStatus }) {
  if (!status?.managed) return null
  const dirty = (status.dirtyCount ?? 0) > 0
  const title = worktreeSummary(status)
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] opacity-80 data-[dirty]:text-(--vscode-gitDecoration-modifiedResourceForeground)" data-dirty={dirty || undefined} title={title} aria-label={title}>
      <span className="codicon codicon-git-branch" aria-hidden="true" />
      {status.branch ?? 'detached'}{dirty ? ' •' : ''}
    </span>
  )
}
