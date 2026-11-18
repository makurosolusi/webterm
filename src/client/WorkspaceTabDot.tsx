import type { CSSProperties } from 'react'
import { signalCounts, type SessionGroup } from './sessionList'
import { workspaceTabDot, workspaceTabTitle } from './workspaceTabs'
import { describeWorkspaceColor, workspaceColorVar } from '../shared/workspaceColor'
import type { Workspace } from '../shared/workspace'
import type { VscodeEditorTab } from '@/components/vscode/vscodeEditorTabBar'

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** Colour name for a workspace, e.g. `pink` or `teal vivid`; `none` while no hue is set. */
export const workspaceColorName = (color: string | undefined, shade: string | undefined): string => {
  const d = describeWorkspaceColor(color, shade)
  return d === 'unset' ? 'none' : d.replace(' default', '')
}

/** Accessible name of a tab: workspace, colour, then live agent status (only the open workspace has any). */
export function workspaceTabAria(group: SessionGroup, color: string | undefined, shade: string | undefined): string {
  const { attention, working } = signalCounts(group.sessions)
  const parts = [`Workspace ${group.projectName}`, `color ${workspaceColorName(color, shade)}`]
  if (attention > 0) parts.push(`${plural(attention, 'agent')} waiting for you`)
  if (working > 0) parts.push(`${plural(working, 'agent')} running`)
  return parts.join(', ')
}

/** Tab dot: filled with the workspace colour; a corner badge carries agent status (working / attention only). */
export function WorkspaceTabDot({ group, color, shade }: { group: SessionGroup; color: string | undefined; shade: string | undefined }) {
  const status = workspaceTabDot(group)
  return (
    <span className="ws-dot" role="img" aria-label={workspaceTabAria(group, color, shade)} style={{ '--ws-dot': workspaceColorVar(color, shade) } as CSSProperties}>
      {(status === 'working' || status === 'attention') && <span className={`ws-dot__badge ws-dot__badge--${status}`} />}
    </span>
  )
}

/** Tab fields derived from a workspace row: dot icon, combined aria-label, and tooltip (counts, optional worktree line, colour name). */
export function workspaceTabFields(group: SessionGroup, w: Pick<Workspace, 'color' | 'colorShade'> | undefined, worktree?: string): Pick<VscodeEditorTab, 'icon' | 'ariaLabel' | 'tooltip'> {
  const { color, colorShade: shade } = w ?? {}
  return {
    icon: <WorkspaceTabDot group={group} color={color} shade={shade} />,
    ariaLabel: workspaceTabAria(group, color, shade),
    tooltip: [workspaceTabTitle(group), worktree, `Color: ${workspaceColorName(color, shade)}`].filter(Boolean).join('\n'),
  }
}
