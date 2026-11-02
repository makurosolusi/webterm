// Tab strip of the VS Code bottom panel: uppercase 11px labels, a 1px top border on the active
// tab, and a 16px count badge. Selection model matches VS Code's panel composite bar: arrows
// move focus, Enter/Space activate, Home/End jump, Delete closes a closable tab.
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

export interface BottomPanelTab {
  id: string
  label: string
  /** Count shown in the 16px badge; omitted or 0 hides the badge. */
  badge?: number
  /** Defaults to true; the tab then shows a close affordance when `onClose` is given. */
  closable?: boolean
  tooltip?: string
}

export interface BottomPanelTabsProps {
  tabs: BottomPanelTab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  ariaLabel: string
}

/** Panel tab strip with count badges. */
export function BottomPanelTabs(props: BottomPanelTabsProps): React.JSX.Element {
  const { tabs, activeId, onActivate, onClose, ariaLabel } = props
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const roving = focusedId !== null && tabs.some((tab) => tab.id === focusedId) ? focusedId : activeId

  const focusTab = (id: string): void => {
    setFocusedId(id)
    refs.current.get(id)?.focus()
  }
  const move = (from: string, delta: 1 | -1): void => {
    const index = tabs.findIndex((tab) => tab.id === from)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (next) focusTab(next.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: BottomPanelTab): void => {
    switch (event.key) {
      case 'ArrowRight': event.preventDefault(); move(tab.id, 1); break
      case 'ArrowLeft': event.preventDefault(); move(tab.id, -1); break
      case 'Home': event.preventDefault(); if (tabs[0]) focusTab(tabs[0].id); break
      case 'End': event.preventDefault(); if (tabs.length) focusTab(tabs[tabs.length - 1]!.id); break
      case 'Enter':
      case ' ': event.preventDefault(); onActivate(tab.id); break
      case 'Delete':
        if (tab.closable !== false && onClose) { event.preventDefault(); onClose(tab.id) }
        break
      default: break
    }
  }

  return (
    <div className="vscode-panel-tabs" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const closeable = tab.closable !== false && onClose !== undefined
        return (
          <div key={tab.id} role="presentation" className="vscode-panel-tab" data-active={active ? 'true' : 'false'}>
            <button
              ref={(element) => { if (element) refs.current.set(tab.id, element); else refs.current.delete(tab.id) }}
              type="button" role="tab" className="vscode-panel-tab__button"
              aria-selected={active} tabIndex={roving === tab.id ? 0 : -1}
              title={tab.tooltip ?? tab.label}
              onClick={() => { setFocusedId(tab.id); onActivate(tab.id) }}
              onFocus={() => setFocusedId(tab.id)}
              onKeyDown={(event) => onKeyDown(event, tab)}
            >
              <span className="vscode-panel-tab__label">{tab.label}</span>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span className="vscode-panel-tab__badge" aria-label={`${tab.badge} items`}>{tab.badge}</span>
              )}
            </button>
            {closeable && (
              <button type="button" className="vscode-panel-tab__close" tabIndex={-1}
                aria-label={`Close ${tab.label}`} title={`Close ${tab.label}`}
                onClick={(event) => { event.stopPropagation(); onClose?.(tab.id) }}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
