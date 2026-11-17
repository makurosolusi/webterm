import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
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
  /** CSS color of the tab's identity marker (bottom bar; the active tab's top border too). Absent = none. */
  accent?: string
  /** Replaces the tab button while set (inline rename); the tab keeps its slot in the strip. */
  editor?: ReactNode
}

export interface VscodeEditorTabBarProps {
  tabs: VscodeEditorTab[]
  /** Controlled active tab id. */
  activeId: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  /** Double-click on a tab (VS Code: pin/keep the preview tab). */
  onDoubleClick?: (id: string) => void
  /** Right-click, Shift+F10 or the ContextMenu key on a tab. `at` is the menu's viewport anchor. */
  onContextMenu?: (id: string, at: { x: number; y: number }) => void
  /** Rendered right after the last tab (VS Code / browser "+"); sticks to the right edge on overflow. */
  trailing?: ReactNode
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
  onContextMenu,
  trailing,
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

  // Keyboard-opened menus (and a `contextmenu` event the ContextMenu key fires at 0,0) anchor
  // under the tab, like VS Code; a mouse right-click anchors at the pointer.
  const openMenu = (tabId: string, el: HTMLElement, pointer?: { x: number; y: number }) => {
    if (!onContextMenu) return
    const r = el.getBoundingClientRect()
    onContextMenu(tabId, pointer && (pointer.x !== 0 || pointer.y !== 0) ? pointer : { x: r.left, y: r.bottom })
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: VscodeEditorTab) => {
    if (onContextMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault()
      openMenu(tab.id, event.currentTarget)
      return
    }
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
    >
      {/* `display: contents`: the tablist holds only tabs, `trailing` sits beside it in the same flex row. */}
      <div className="vscode-editor-tabs__list" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
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
            data-accent={tab.accent ? 'true' : undefined}
            style={tab.accent ? ({ '--tab-accent': tab.accent } as CSSProperties) : undefined}
            className="vscode-editor-tab"
          >
            {tab.editor ?? <IconTooltip label={tab.tooltip ?? tab.label}>
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
                onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
                  if (!onContextMenu) return
                  event.preventDefault()
                  openMenu(tab.id, event.currentTarget, { x: event.clientX, y: event.clientY })
                }}
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
            </IconTooltip>}
            {tab.editor ? null : closeable ? (
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
      {trailing ? <div className="vscode-editor-tabs__trailing" data-slot="vscode-editor-tabs-trailing">{trailing}</div> : null}
    </div>
  )
}
