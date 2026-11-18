// Two small controls shared by the header's modes: the command center pill (active workspace identity +
// search) and the board layout toggle. Full shows them in the title bar / tab row, Compact in its single
// row, Hidden in the revealed title bar: one implementation, so the three modes cannot drift apart.
import type { CSSProperties } from 'react'
import { IconTooltip, useCommandShortcut } from '@/components/ui/icon-button'
import { WorkspaceWorktreeBadge } from './WorkspaceWorktreeBadge'
import type { WorktreeStatus } from './workspaceWorktree.api'

export interface CommandPillProps {
  /** Opens the omnibox; absent = a plain, non-interactive name. */
  onOpenPalette?: () => void
  /** CSS color of the active workspace (`var(--ws-*)`); absent = no chip. */
  accent?: string
  name?: string
  worktree?: WorktreeStatus
}

/** VS Code command center: opens Go to Anything, shows the active workspace and the chord. */
export function CommandPill({ onOpenPalette, accent, name, worktree }: CommandPillProps) {
  const paletteKey = useCommandShortcut('workbench.omnibox')
  if (!onOpenPalette) {
    return (
      <span className="app-titlebar__name">
        {name ?? ''}
        <WorkspaceWorktreeBadge status={worktree} />
      </span>
    )
  }
  return (
    <IconTooltip label="Go to anything: nodes, files, URLs, agents, commands" commandId="workbench.omnibox">
      <button type="button" className="app-titlebar__name" aria-label="Search" onClick={onOpenPalette}>
        <span className="codicon codicon-search" aria-hidden />
        {accent && <span className="ws-chip" aria-hidden style={{ '--ws-chip': accent } as CSSProperties} />}
        <span className="app-titlebar__label">{name ?? 'Search'}</span>
        <WorkspaceWorktreeBadge status={worktree} />
        {paletteKey && <span className="kbd">{paletteKey}</span>}
      </button>
    </IconTooltip>
  )
}

/** One layout switch per board (VS Code keeps layout controls in the title bar, not per editor group). */
export function LayoutToggle({ layoutMode, onToggle }: { layoutMode?: 'canvas' | 'tabs'; onToggle: () => void }) {
  return (
    <IconTooltip label={layoutMode === 'tabs' ? 'Switch to canvas layout' : 'Switch to tab layout'} commandId="view.layout.toggle">
      <button type="button" className="app-tabs__action" aria-label="Toggle tab layout" aria-pressed={layoutMode === 'tabs'} onClick={onToggle}>
        <span className="codicon codicon-editor-layout" aria-hidden />
      </button>
    </IconTooltip>
  )
}
