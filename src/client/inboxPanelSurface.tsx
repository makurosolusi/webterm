// VS Code bottom-panel surface shared by Inbox, Chat, and the combined Inbox/Chat shell.
//
// The title bar is the same `VscodeEditorTabBar` used by editor surfaces: 35px tall, 13px
// labels, and a 1px active top border. Panel rows (`.inbox-item`, `.chat-list-item`) are
// 22px tall; those live in the panels' own sheets, which scope every selector under the
// panel class so an embedded pane inherits the metrics without the surface chrome.
import type { ReactNode } from 'react'
import { VscodeEditorTabBar, type VscodeEditorTab } from './components/vscode/vscodeEditorTabBar'
import './inboxPanelSurface.css'

export interface InboxPanelSurfaceProps {
  tabs: VscodeEditorTab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  /** Right-aligned title-bar controls (refresh, counts). Close lives on the tab. */
  actions?: ReactNode
  children: ReactNode
  className?: string
  ariaLabel: string
  tabsLabel?: string
}

/**
 * Bottom-docked VS Code panel: absolute over the canvas, anchored above the bottom edge and
 * clear of the left Dock column. Owns surface chrome only; tab content and data stay in the
 * panel components.
 */
export function InboxPanelSurface(props: InboxPanelSurfaceProps): React.JSX.Element {
  const { tabs, activeId, onActivate, onClose, actions, children, className, ariaLabel } = props
  return (
    <section
      className={['vscode-bottom-panel', className].filter(Boolean).join(' ')}
      role="complementary"
      aria-label={ariaLabel}
    >
      <div className="vscode-bottom-panel__titlebar">
        <VscodeEditorTabBar
          tabs={tabs}
          activeId={activeId}
          onActivate={onActivate}
          {...(onClose === undefined ? {} : { onClose })}
          ariaLabel={props.tabsLabel ?? `${ariaLabel} tabs`}
        />
        {actions !== undefined && (
          <div className="vscode-bottom-panel__actions">{actions}</div>
        )}
      </div>
      <div className="vscode-bottom-panel__body">{children}</div>
    </section>
  )
}
