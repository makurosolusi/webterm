import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import './vscode-shell.css'

export interface VscodeEditorTab {
  id: string
  label: string
  icon?: ReactNode
  /** Shows a 7px dot in the close slot until the tab is hovered or focused. */
  dirty?: boolean
  /** Defaults to true; pass false for pinned/preview tabs. */
  closable?: boolean
  tooltip?: string
}

export interface VscodeEditorTabBarProps {
  tabs: VscodeEditorTab[]
  /** Controlled active tab id. */
  activeId: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  /** Double-click on a tab (VS Code: pin/keep the preview tab). */
  onDoubleClick?: (id: string) => void
  className?: string
  ariaLabel?: string
}

/**
 * VS Code editor tab strip: 35px tall, 13px labels, `0 10px` padding, a 16px close
 * affordance, and a 1px accent top border on the active tab.
 *
 * Focus and selection are separate: Left/Right/Home/End move focus only, Enter/Space
 * (or a click) activates, and Delete, Cmd/Ctrl+W or a middle-click closes a tab. The active
 * tab is scrolled into view when it changes, and vertical wheel deltas scroll the
 * strip horizontally.
 */
export function VscodeEditorTabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onDoubleClick,
  className,
  ariaLabel = 'Editor tabs',
}: VscodeEditorTabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [focusedId, setFocusedId] = useState<string | null>(activeId)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    setFocusedId(activeId)
    if (!activeId) return
    const tab = tabRefs.current.get(activeId)
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const update = () => setOverflowing(strip.scrollWidth > strip.clientWidth + 1)
    update()
    strip.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      strip.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [tabs])

  // React attaches wheel listeners passively, so the translation to horizontal scroll
  // needs a native non-passive listener to call preventDefault.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || event.shiftKey) return
      if (strip.scrollWidth <= strip.clientWidth) return
      event.preventDefault()
      strip.scrollLeft += event.deltaY
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])

  const focusTab = (tabId: string) => {
    setFocusedId(tabId)
    tabRefs.current.get(tabId)?.focus()
  }

  const moveFocus = (fromId: string, delta: 1 | -1) => {
    if (tabs.length === 0) return
    const index = tabs.findIndex((tab) => tab.id === fromId)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (next) focusTab(next.id)
  }

  const closeTab = (tab: VscodeEditorTab) => {
    if (tab.closable === false || !onClose) return
    onClose(tab.id)
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: VscodeEditorTab) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        moveFocus(tab.id, 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveFocus(tab.id, -1)
        break
      case 'Home':
        event.preventDefault()
        if (tabs[0]) focusTab(tabs[0].id)
        break
      case 'End':
        event.preventDefault()
        if (tabs[tabs.length - 1]) focusTab(tabs[tabs.length - 1].id)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        onActivate(tab.id)
        break
      case 'Delete':
        if (tab.closable !== false && onClose) {
          event.preventDefault()
          closeTab(tab)
        }
        break
      default:
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
          event.preventDefault()
          closeTab(tab)
        }
        break
    }
  }

  return (
    <div
      ref={stripRef}
      className={['vscode-editor-tabs', className].filter(Boolean).join(' ')}
      data-slot="vscode-editor-tabs"
      data-overflowing={overflowing ? 'true' : 'false'}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const focusable = (focusedId ?? activeId) === tab.id
        const closeable = tab.closable !== false && Boolean(onClose)
        const dirtyDot = <span className="vscode-editor-tab__dirty" data-slot="vscode-editor-tab-dirty" />
        return (
          <div
            key={tab.id}
            role="presentation"
            data-slot="vscode-editor-tab"
            data-active={active ? 'true' : 'false'}
            data-dirty={tab.dirty ? 'true' : 'false'}
            className="vscode-editor-tab"
          >
            <IconTooltip label={tab.tooltip ?? tab.label}>
              <button
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.id, element)
                  else tabRefs.current.delete(tab.id)
                }}
                type="button"
                role="tab"
                data-slot="vscode-editor-tab-button"
                className="vscode-editor-tab__button"
                aria-selected={active}
                tabIndex={focusable ? 0 : -1}
                onClick={() => {
                  setFocusedId(tab.id)
                  onActivate(tab.id)
                }}
                onDoubleClick={() => onDoubleClick?.(tab.id)}
                // Middle button: suppress browser autoscroll on press, close on release (VS Code).
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault()
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  closeTab(tab)
                }}
                onFocus={() => setFocusedId(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, tab)}
              >
                {tab.icon ? (
                  <span className="vscode-editor-tab__icon" aria-hidden="true">
                    {tab.icon}
                  </span>
                ) : null}
                <span className="vscode-editor-tab__label">{tab.label}</span>
              </button>
            </IconTooltip>
            {closeable ? (
              <IconTooltip label={`Close ${tab.label}`}>
                <button
                  type="button"
                  data-slot="vscode-editor-tab-close"
                  className="vscode-editor-tab__close"
                  aria-label={`Close ${tab.label}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab)
                  }}
                >
                  {tab.dirty ? dirtyDot : null}
                  <span className="codicon codicon-close" aria-hidden="true" />
                </button>
              </IconTooltip>
            ) : tab.dirty ? (
              <span className="vscode-editor-tab__close" aria-hidden="true">
                {dirtyDot}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
