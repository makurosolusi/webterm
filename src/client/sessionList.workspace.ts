// Workspace group header in the Sessions view's Project tab (Orca-style stacked list): the status
// dot and the "folder · branch" second line. Pure and DOM-free, like `./sessionList`.
import { rowMeta, type SignalCounts } from './sessionList'

/** One dot per workspace: the most demanding signal among its sessions wins. */
export type WorkspaceDot = 'attention' | 'running' | 'idle'

export const WORKSPACE_DOT_LABEL: Record<WorkspaceDot, string> = {
  attention: 'Needs attention',
  running: 'Running',
  idle: 'Idle',
}

/** attention > running > idle, from the header's own badge counts. */
export function workspaceDot(signals: SignalCounts): WorkspaceDot {
  if (signals.attention > 0) return 'attention'
  return signals.working > 0 ? 'running' : 'idle'
}

/** Second header line: folder name of the workspace cwd, then the git branch when known. */
export function workspaceSubline(cwd: string | undefined, branch: string | undefined): string {
  return [...rowMeta(undefined, cwd), branch ?? ''].filter(Boolean).join(' · ')
}
