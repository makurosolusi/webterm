// Workspace group header in the Sessions view's Project tab (Orca-style stacked list): the
// "folder · branch" second line. Pure and DOM-free, like `./sessionList`. The header carries no
// status dot: its labeled "needs you" badge is the one status mark (sessions audit gap 7).
import { rowMeta } from './sessionList'

/** Second header line: folder name of the workspace cwd, then the git branch when known. */
export function workspaceSubline(cwd: string | undefined, branch: string | undefined): string {
  return [...rowMeta(undefined, cwd), branch ?? ''].filter(Boolean).join(' · ')
}
