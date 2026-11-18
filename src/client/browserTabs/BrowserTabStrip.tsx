// Tab strip of a browser node (Chrome/VS Code pattern). Fully controlled: state in, `onAction` out; no fetch or WS.
// Tabs shrink from 220px to 96px, then the strip scrolls with chevrons and an All-tabs list. Not a native
// control: tabs are role=tab divs, so the strip imports the VS Code menu layer like the other hybrid screens.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu, type VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import { isMacPlatform } from '@/terminalKeys'
import {
  MAX_TABS_PER_NODE, canAddTab, newTabId, nextActiveAfterClose, type BrowserTabAction, type BrowserTabsState,
} from '../../shared/browser.tabs'
import { BrowserTabItem } from './BrowserTabItem'
import { useTabDrag } from './browserTabs.drag'
import { focusTarget, tabKeyIntent } from './browserTabs.keys'
import { allTabsItems, tabContextItems } from './browserTabs.menu'
import { prefersReducedMotion, useTabOverflow } from './browserTabs.overflow'
import './browserTabs.css'

export interface BrowserTabStripProps {
  state: BrowserTabsState
  onAction: (a: BrowserTabAction) => void
  /** Short feedback line ("URL copied", the limit reason); the parent decides how to show it. */
  onNotice?: (text: string) => void
  /** Id source for new tabs; defaults to a random one. */
  makeId?: () => string
  /** DOM id of the tabpanel the tabs control (sets aria-controls). */
  panelId?: string
}

type OpenMenu = { kind: 'tab'; tabId: string; at: { x: number; y: number } } | { kind: 'all'; at: { x: number; y: number } }

export function BrowserTabStrip({ state, onAction, onNotice, makeId = newTabId, panelId }: BrowserTabStripProps) {
  const { tabs, activeTabId, agentTabId } = state
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(activeTabId)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const add = canAddTab(state)
  const overflow = useTabOverflow(listRef, `${tabs.length}:${activeTabId}`)
  const tabEls = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
  const rovingId = tabs.some((t) => t.tabId === focusedId) ? focusedId : activeTabId ?? tabs[0]?.tabId ?? null
  const drag = useTabDrag({
    stripRef: rootRef, tabIds: tabs.map((t) => t.tabId), tabElements: tabEls,
    onReorder: (tabId, toIndex) => onAction({ type: 'reorder', tabId, toIndex }),
    onPopOut: (tabId) => onAction({ type: 'popOut', tabId }),
  })

  useEffect(() => { setFocusedId(activeTabId) }, [activeTabId])
  useEffect(() => {
    const el = tabEls().find((t) => t.dataset.tabId === activeTabId)
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [activeTabId, tabs.length])

  const newTab = (afterTabId?: string) => {
    if (!add.ok) { onNotice?.(add.reason); return }
    onAction({ type: 'new', newTabId: makeId(), afterTabId })
  }
  const focusTab = (id: string) => {
    setFocusedId(id)
    tabEls().find((t) => t.dataset.tabId === id)?.focus()
  }
  const copyUrl = (url: string) => {
    if (!navigator.clipboard) { onNotice?.('Clipboard is not available'); return }
    navigator.clipboard.writeText(url).then(
      () => onNotice?.('URL copied'),
      (e: unknown) => onNotice?.(`Could not copy the URL: ${e instanceof Error ? e.message : 'permission denied'}`),
    )
  }
  const rectAnchor = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom } }

  const onKeyDown = (e: KeyboardEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
    const id = el?.dataset.tabId
    const intent = tabKeyIntent(e, isMacPlatform())
    if (!el || !id || !intent) return
    const i = tabs.findIndex((t) => t.tabId === id)
    e.preventDefault()
    e.stopPropagation()
    if (intent.kind === 'focus') focusTab(tabs[focusTarget(intent.to, i, tabs.length)].tabId)
    else if (intent.kind === 'move') onAction({ type: 'reorder', tabId: id, toIndex: i + intent.dir })
    else if (intent.kind === 'activate') onAction({ type: 'activate', tabId: id })
    else if (intent.kind === 'menu') setMenu({ kind: 'tab', tabId: id, at: rectAnchor(el) })
    else {
      const next = nextActiveAfterClose(tabs, id)
      onAction({ type: 'close', tabId: id })
      if (next) focusTab(next)
    }
  }
  const onRootDoubleClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget || e.target === listRef.current || (e.target as HTMLElement).dataset.stripEmpty !== undefined) newTab()
  }

  const menuTab = menu?.kind === 'tab' ? tabs.find((t) => t.tabId === menu.tabId) : undefined
  const menuItems: VscodeMenuItem[] = menu?.kind === 'all'
    ? allTabsItems(state, (tabId) => onAction({ type: 'activate', tabId }))
    : menuTab ? tabContextItems(menuTab, { state, run: onAction, copyUrl, makeId }) : []
  const dragIndex = drag.view ? tabs.findIndex((t) => t.tabId === drag.view?.tabId) : -1

  return (
    <div ref={rootRef} className="bt-strip" data-popout-armed={drag.view?.popOut || undefined} onDoubleClick={onRootDoubleClick}>
      {overflow.overflowing && (
        <IconButton label="Scroll tabs left" size="icon-xs" className="bt-chevron" disabled={!overflow.canLeft} onClick={() => overflow.scroll(-1)}>
          <ChevronLeft aria-hidden="true" />
        </IconButton>
      )}
      <div ref={listRef} role="tablist" aria-label="Browser tabs" aria-orientation="horizontal" className="bt-list" onKeyDown={onKeyDown}>
        {tabs.map((tab, i) => (
          <BrowserTabItem
            key={tab.tabId}
            tab={tab}
            active={tab.tabId === activeTabId}
            isAgent={tab.tabId === agentTabId || tab.agent === true}
            focusable={tab.tabId === rovingId}
            panelId={panelId}
            dragging={drag.view?.tabId === tab.tabId}
            drop={drag.view?.slot === i ? 'before' : drag.view?.slot === tabs.length && i === tabs.length - 1 ? 'after' : undefined}
            onActivate={() => { if (!drag.wasDragged()) onAction({ type: 'activate', tabId: tab.tabId }) }}
            onClose={() => onAction({ type: 'close', tabId: tab.tabId })}
            onFocus={() => setFocusedId(tab.tabId)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', tabId: tab.tabId, at: { x: e.clientX, y: e.clientY } }) }}
            onPointerDown={(e) => drag.begin(e, tab.tabId)}
          />
        ))}
      </div>
      {overflow.overflowing && (
        <IconButton label="Scroll tabs right" size="icon-xs" className="bt-chevron" disabled={!overflow.canRight} onClick={() => overflow.scroll(1)}>
          <ChevronRight aria-hidden="true" />
        </IconButton>
      )}
      <div className="bt-spacer" data-strip-empty />
      {overflow.overflowing && (
        <IconButton label="All tabs" size="icon-xs" aria-haspopup="menu" onClick={(e) => setMenu({ kind: 'all', at: rectAnchor(e.currentTarget) })}>
          <ChevronDown aria-hidden="true" />
        </IconButton>
      )}
      {!add.ok && (
        <span className="bt-limit" role="status"><span aria-hidden="true">{tabs.length}/{MAX_TABS_PER_NODE}</span><span className="bt-sr">{add.reason}</span></span>
      )}
      <IconButton label="New tab" size="icon-xs" disabled={!add.ok} disabledReason={add.ok ? undefined : add.reason} onClick={() => newTab()}>
        <Plus aria-hidden="true" />
      </IconButton>
      {menu && <VscodeMenu open anchor={menu.at} items={menuItems} onClose={() => setMenu(null)} ariaLabel={menu.kind === 'all' ? 'All tabs' : 'Tab actions'} />}
    </div>
  )
}
