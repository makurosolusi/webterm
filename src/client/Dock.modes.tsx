// Bottom group of the rail (ala "Manage" VS Code): Account (Compact/Hidden), Settings (opens a dialog), the
// Hidden header's layout switch, then lock and clean view, which are TOGGLES (`aria-pressed`) that the
// navigation items of the activity bar cannot be.
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { codicon } from './dockCodicon'

export interface DockModesProps {
  /** Compact/Hidden: the Account button, above Settings. */
  railAccount?: ReactNode
  onOpenSettings?: () => void
  /** Hidden: the board layout switch (the header has no tab row to hold it). */
  railLayout?: ReactNode
  /** Lock view only exists on the canvas layout. */
  canvasMode: boolean
  locked: boolean
  onToggleLock: () => void
  cleanView: boolean
  onToggleCleanView: () => void
}

export function DockModes(p: DockModesProps) {
  return (
    <div className="dock__modes" data-slot="dock-modes">
      {p.railAccount}
      {p.onOpenSettings && (
        <IconButton className="vscode-activity-bar__item dock-btn rounded-none" label="Settings" commandId="workbench.settings"
          side="right" onClick={p.onOpenSettings}>
          <span className="vscode-activity-bar__icon" aria-hidden>{codicon('settings-gear')}</span>
        </IconButton>
      )}
      {p.railLayout}

      {p.canvasMode && (
        <IconButton
          className="vscode-activity-bar__item dock-btn rounded-none"
          label={p.locked ? 'Unlock view' : 'Lock view'}
          tooltip={p.locked ? 'View locked: pan and zoom are off. Click to unlock' : 'View unlocked. Click to lock pan and zoom; nodes stay movable'}
          side="right"
          aria-pressed={p.locked}
          onClick={p.onToggleLock}
        >
          <span className="vscode-activity-bar__icon" aria-hidden>{codicon(p.locked ? 'lock' : 'unlock')}</span>
        </IconButton>
      )}

      <IconButton
        className="vscode-activity-bar__item dock-btn rounded-none"
        label="Clean view"
        tooltip={p.cleanView ? 'Clean view is on. Click to show the chrome again' : 'Clean view is off. Click to hide all chrome'}
        commandId="view.cleanView"
        side="right"
        aria-pressed={p.cleanView}
        onClick={p.onToggleCleanView}
      >
        <span className="vscode-activity-bar__icon" aria-hidden>{codicon('eye-closed')}</span>
      </IconButton>
    </div>
  )
}
