// VS Code bottom-panel surface shared by Inbox, Chat, and the combined Inbox/Chat shell.
//
// Layout follows VS Code's panel: a sash on the top edge, a 35px title row (uppercase 11px
// tabs with a count badge on the left, an action toolbar on the right), then the body.
// Panel rows (`.inbox-item`, `.chat-list-item`) are 22px tall; those live in the panels' own
// sheets, which scope every selector under the panel class so an embedded pane inherits the
// metrics without the surface chrome.
import type { ReactNode, Ref } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { bottomPanelHeight } from './bottomPanelHeight'
import { PanelSash } from './bottomPanelSash'
import { sideBarWidth } from './secondarySideBar.store'
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
  /** Mount point in the toolbar for the active pane's own actions (portal target of a shared host). */
  actionsSlotRef?: Ref<HTMLSpanElement>
  children: ReactNode
  className?: string
  ariaLabel: string
  tabsLabel?: string
  /** `right` = the secondary side bar (sash on the left edge, side-bar labels); default the bottom panel. */
  dock?: 'bottom' | 'right'
}

const DOCKS = {
  bottom: {
    size: bottomPanelHeight, rootClass: 'vscode-bottom-panel', sash: 'horizontal', sashLabel: 'Resize panel', sashClass: 'vscode-bottom-panel__sash',
    maximize: ['Maximize Panel Size', 'Click to maximize the panel', 'codicon-chevron-up'],
    restore: ['Restore Panel Size', 'Panel maximized. Click to restore its size', 'codicon-chevron-down'],
    close: 'Close Panel',
  },
  right: {
    size: sideBarWidth, rootClass: 'vscode-secondary-side-bar', sash: 'vertical', sashLabel: 'Resize side bar', sashClass: 'vscode-secondary-side-bar__sash',
    maximize: ['Maximize Secondary Side Bar', 'Click to widen the side bar over the canvas', 'codicon-screen-full'],
    restore: ['Restore Secondary Side Bar', 'Side bar maximized. Click to restore its width', 'codicon-screen-normal'],
    close: 'Hide Secondary Side Bar',
  },
} as const

/**
 * Docked VS Code part: the bottom panel (flush with the status bar) or the secondary side bar
 * (right edge). Owns surface chrome only; tab content and data stay in the panel components.
 */
export function InboxPanelSurface(props: InboxPanelSurfaceProps): React.JSX.Element {
  const { tabs, activeId, onActivate, onClose, onClosePanel, actions, actionsSlotRef, children, className, ariaLabel } = props
  const dock = DOCKS[props.dock ?? 'bottom']
  const { maximized } = dock.size.use()
  const [maximizeLabel, maximizeTip, maximizeIcon] = maximized ? dock.restore : dock.maximize
  return (
    <section
      className={[dock.rootClass, className].filter(Boolean).join(' ')}
      data-maximized={maximized ? 'true' : 'false'}
      role="complementary"
      aria-label={ariaLabel}
    >
      <PanelSash size={dock.size} orientation={dock.sash} label={dock.sashLabel} className={dock.sashClass} />
      <div className="vscode-bottom-panel__titlebar">
        <BottomPanelTabs
          tabs={tabs}
          activeId={activeId}
          onActivate={onActivate}
          {...(onClose === undefined ? {} : { onClose })}
          ariaLabel={props.tabsLabel ?? `${ariaLabel} tabs`}
        />
        <div className="vscode-bottom-panel__actions" role="toolbar" aria-label={`${ariaLabel} actions`}>
          {actionsSlotRef && <span ref={actionsSlotRef} className="vscode-bottom-panel__slot" />}
          {actions}
          <IconTooltip label={maximizeTip}>
            <button type="button" className="vscode-panel-action" aria-label={maximizeLabel}
              aria-pressed={maximized} onClick={dock.size.toggleMaximized}>
              <span className={`codicon ${maximizeIcon}`} aria-hidden="true" />
            </button>
          </IconTooltip>
          {onClosePanel !== undefined && (
            <IconTooltip label={dock.close}>
              <button type="button" className="vscode-panel-action" aria-label={dock.close} onClick={onClosePanel}>
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
