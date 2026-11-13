// Group header of the Sessions tree as a branch `TreeItem`: a workspace (Project tab: monogram,
// name, Current chip, "folder · branch" below) or a status bucket (Status tab: the bucket's icon,
// shown once here instead of on every row). Badges always say what they count (tooltip + label).
import type { CSSProperties, ReactNode } from 'react'
import { TreeItem } from './vscode/register'
import { InlineAction, type RegisterTreeTarget } from './SessionRow'
import { SWITCH_WORKSPACE_LABEL } from './sessionMenu'
import { groupAriaLabel, needsYouLabel, sessionsCountLabel } from './sessionList.row'

/** Chip after the name of the workspace open on the board. */
export const CURRENT_CHIP = 'Current'

export interface SessionGroupItemProps {
  /** Kunci lipatan yang dipersist panel (`collapsed`). */
  groupKey: string
  label: string
  count: number
  open: boolean
  register: RegisterTreeTarget
  /** Board yang sedang terbuka di canvas: hanya tab Project yang mengisinya. */
  isActive?: boolean
  projectId?: string
  /** Inisial workspace, menggantikan ikon kind. */
  monogram?: string
  color?: string
  /** Glyph untuk grup non-workspace (bucket Status, Recently closed). */
  icon?: ReactNode
  /** Sessions in this group that need you; > 0 shows the one labeled attention badge. */
  attention?: number
  /**
   * Grup workspace membawa id board untuk inline action / context menu "Switch to Workspace".
   * Klik header (grup apa pun) hanya melipat: pindah board dari klik expand adalah bug lama.
   */
  workspace?: boolean
  /** Inline "Switch to Workspace" action; rendered for a workspace group that is not the open board. */
  onSwitchWorkspace?: (projectId: string) => void
  /** Workspace header only: the "folder · branch" second line. */
  sub?: string
  children: ReactNode
}

/** Workspace header label (Orca layout): name and Current chip, then folder · branch below. */
function WorkspaceLabel({ label, isActive, sub }: { label: string; isActive: boolean; sub?: string }) {
  return (
    <span className="ss-ws">
      <span className="ss-ws__line">
        <span className={isActive ? 'ss-tree__group-label ss-tree__group-label--active' : 'ss-tree__group-label'} title={[label, sub].filter(Boolean).join(' — ')}>{label}</span>
        {isActive && <span className="ss-ws__chip">{CURRENT_CHIP}</span>}
      </span>
      {sub && <span className="ss-ws__sub">{sub}</span>}
    </span>
  )
}

/** The same glyph closed and open (the library swaps slots on toggle). */
function BranchIcon({ className, style, children }: { className: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <>
      <span slot="icon-branch" className={className} style={style} aria-hidden>{children}</span>
      <span slot="icon-branch-opened" className={className} style={style} aria-hidden>{children}</span>
    </>
  )
}

/** Header grup sebagai branch tree. Chevron, hover, dan tinggi 22px milik library. */
export function SessionGroupItem(props: SessionGroupItemProps) {
  const { groupKey, label, count, open, register, isActive = false, projectId, monogram, color, icon } = props
  const { attention = 0, workspace = false, onSwitchWorkspace, sub, children } = props
  const groupClass = ['ss-tree__group', workspace && 'ss-tree__group--ws', isActive && 'ss-tree__group--active'].filter(Boolean).join(' ')

  return (
    <TreeItem
      branch
      open={open}
      className={groupClass}
      aria-label={groupAriaLabel(label, count, attention, isActive)}
      aria-current={isActive ? 'true' : undefined}
      data-group={groupKey}
      ref={(el) => register(el, workspace ? { kind: 'group', key: groupKey, projectId, isActive } : { kind: 'group', key: groupKey })}
    >
      {monogram !== undefined ? (
        <BranchIcon className="ss-tree__monogram" style={color ? { background: color } : undefined}>{monogram}</BranchIcon>
      ) : icon ? (
        <BranchIcon className="ss-tree__kind">{icon}</BranchIcon>
      ) : null}
      {workspace ? <WorkspaceLabel label={label} isActive={isActive} sub={sub} /> : <span className="ss-tree__group-label" title={label}>{label}</span>}
      <span slot="decoration" className="ss-tree__decoration">
        {attention > 0 && (
          <span className="ss-signal ss-signal--attention" title={needsYouLabel(attention)} aria-label={needsYouLabel(attention)}>
            {attention}
          </span>
        )}
        <span className="ss-tree__count" title={sessionsCountLabel(count)} aria-label={sessionsCountLabel(count)}>{count}</span>
      </span>
      {workspace && projectId && !isActive && onSwitchWorkspace && (
        <InlineAction
          icon="arrow-right"
          tooltip={SWITCH_WORKSPACE_LABEL}
          ariaLabel={`${SWITCH_WORKSPACE_LABEL} ${label}`}
          className="ss-tree__switch"
          onActivate={() => onSwitchWorkspace(projectId)}
        />
      )}
      {children}
    </TreeItem>
  )
}
