// VS Code bottom-panel surface shared by Inbox, Chat, and the combined Inbox/Chat shell.
//
// Layout follows VS Code's panel: a sash on the top edge, a 35px title row (uppercase 11px
// tabs with a count badge on the left, an action toolbar on the right), then the body.
// Panel rows (`.inbox-item`, `.chat-list-item`) are 22px tall; those live in the panels' own
// sheets, which scope every selector under the panel class so an embedded pane inherits the
// metrics without the surface chrome.
import type { ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { togglePanelMaximized, usePanelHeight } from './bottomPanelHeight'
import { BottomPanelSash } from './bottomPanelSash'
import { BottomPanelTabs, type BottomPanelTab } from './bottomPanelTabs'
import './inboxPanelSurface.css'

export interface InboxPanelSurfaceProps {
  tabs: BottomPanelTab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  /** Closes the whole panel (toolbar `close`); the toolbar button is hidden without it. */
  onClosePanel?: () => void
  /** Extra title-bar controls placed before maximize/close (refresh, ...). */
  actions?: ReactNode
  children: ReactNode
  className?: string
  ariaLabel: string
  tabsLabel?: string
}

/**
 * Bottom-docked VS Code panel: absolute over the canvas, flush with the status bar. Owns
 * surface chrome only; tab content and data stay in the panel components.
 */
export function InboxPanelSurface(props: InboxPanelSurfaceProps): React.JSX.Element {
  const { tabs, activeId, onActivate, onClose, onClosePanel, actions, children, className, ariaLabel } = props
  const { maximized } = usePanelHeight()
  const maximizeLabel = maximized ? 'Restore Panel Size' : 'Maximize Panel Size'
  const maximizeTip = maximized ? 'Panel maximized. Click to restore its size' : 'Click to maximize the panel'
  return (
    <section
      className={['vscode-bottom-panel', className].filter(Boolean).join(' ')}
      data-maximized={maximized ? 'true' : 'false'}
      role="complementary"
      aria-label={ariaLabel}
    >
      <BottomPanelSash />
      <div className="vscode-bottom-panel__titlebar">
        <BottomPanelTabs
          tabs={tabs}
          activeId={activeId}
          onActivate={onActivate}
          {...(onClose === undefined ? {} : { onClose })}
          ariaLabel={props.tabsLabel ?? `${ariaLabel} tabs`}
        />
        <div className="vscode-bottom-panel__actions" role="toolbar" aria-label={`${ariaLabel} actions`}>
          {actions}
          <IconTooltip label={maximizeTip}>
            <button type="button" className="vscode-panel-action" aria-label={maximizeLabel}
              aria-pressed={maximized} onClick={togglePanelMaximized}>
              <span className={`codicon codicon-chevron-${maximized ? 'down' : 'up'}`} aria-hidden="true" />
            </button>
          </IconTooltip>
          {onClosePanel !== undefined && (
            <IconTooltip label="Close Panel">
              <button type="button" className="vscode-panel-action" aria-label="Close Panel" onClick={onClosePanel}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </IconTooltip>
          )}
        </div>
      </div>
      <div className="vscode-bottom-panel__body">{children}</div>
    </section>
  )
}
