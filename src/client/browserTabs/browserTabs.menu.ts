// Menu rows for the tab context menu and the All-tabs list. Pure: callers pass what a row does.
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import { canAddTab, type BrowserTab, type BrowserTabAction, type BrowserTabsState } from '../../shared/browser.tabs'
import { chordLabel } from '@/commandRegistry'
import { isMacPlatform } from '@/terminalKeys'
import { isBlankTab, tabTitle } from './browserTabs.labels'

export interface TabMenuDeps {
  state: BrowserTabsState
  /** Runs a state action; ids for new tabs are already stamped by the caller. */
  run: (a: BrowserTabAction) => void
  copyUrl: (url: string) => void
  makeId: () => string
}

/** Context menu of one tab (Chrome order: new/duplicate/reload, close group, node-level actions, copy). */
export function tabContextItems(tab: BrowserTab, d: TabMenuDeps): VscodeMenuItem[] {
  const { state, run } = d
  const index = state.tabs.findIndex((t) => t.tabId === tab.tabId)
  const add = canAddTab(state)
  const limit = add.ok ? undefined : add.reason
  const onlyTab = state.tabs.length === 1
  return [
    { type: 'item', id: 'new-right', label: 'New tab to the right', disabled: !add.ok, title: limit,
      onSelect: () => run({ type: 'new', newTabId: d.makeId(), afterTabId: tab.tabId }) },
    { type: 'item', id: 'duplicate', label: 'Duplicate', disabled: !add.ok, title: limit,
      onSelect: () => run({ type: 'duplicate', tabId: tab.tabId, newTabId: d.makeId() }) },
    { type: 'item', id: 'reload', label: 'Reload', disabled: isBlankTab(tab), onSelect: () => run({ type: 'reload', tabId: tab.tabId }) },
    { type: 'separator' },
    { type: 'item', id: 'close', label: 'Close', keybinding: chordLabel('Mod+W', isMacPlatform()), onSelect: () => run({ type: 'close', tabId: tab.tabId }) },
    { type: 'item', id: 'close-others', label: 'Close others', disabled: onlyTab, title: onlyTab ? 'No other tabs' : undefined,
      onSelect: () => run({ type: 'closeOthers', tabId: tab.tabId }) },
    { type: 'item', id: 'close-right', label: 'Close to the right', disabled: index === state.tabs.length - 1,
      title: index === state.tabs.length - 1 ? 'No tabs to the right' : undefined,
      onSelect: () => run({ type: 'closeToRight', tabId: tab.tabId }) },
    { type: 'separator' },
    { type: 'item', id: 'pop-out', label: 'Pop out to its own node', disabled: onlyTab, title: onlyTab ? 'This is the only tab in the node' : undefined,
      onSelect: () => run({ type: 'popOut', tabId: tab.tabId }) },
    { type: 'item', id: 'copy-url', label: 'Copy URL', disabled: isBlankTab(tab), onSelect: () => d.copyUrl(tab.url) },
  ]
}

/** All-tabs dropdown: one row per tab, the active one checked. */
export function allTabsItems(state: BrowserTabsState, activate: (tabId: string) => void): VscodeMenuItem[] {
  return state.tabs.map((t) => ({
    type: 'item' as const, id: t.tabId, label: tabTitle(t), checked: t.tabId === state.activeTabId, onSelect: () => activate(t.tabId),
  }))
}
