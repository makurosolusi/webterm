// Tab-layout commands in the shared registry: the mode toggle is always there; the tab shortcuts
// exist only in tab mode, so canvas mode never swallows ⌘1..9 / ⇧⌘[ for nothing.
import { useMemo, useRef } from 'react'
import { useRegisterCommands, type Command } from './commandRegistry'
import { isMacPlatform } from './terminalKeys'
import { NEXT_TAB_KEY, PREV_TAB_KEY, TOGGLE_LAYOUT_KEY, closeTabKey } from './tabLayout.keys'
import { revealInTabs } from './nodeReveal'
import { getTabLayout, setMode, tabModeOrder, useTabLayout } from './tabLayout.store'
import { toggleNodeTabs } from './nodeTabs.visible'

export const TOGGLE_LAYOUT_ID = 'view.layout.toggle'
export const TOGGLE_NODE_TABS_ID = 'view.nodeTabs.toggle'
const inTabs = (): boolean => getTabLayout().mode === 'tabs'

export const toggleLayoutMode = (): void => setMode(inTabs() ? 'canvas' : 'tabs')

/** Show the Nth tab (1-based); out of range = no-op. */
export function gotoTab(n: number): void {
  const id = inTabs() ? tabModeOrder()[n - 1] : undefined
  if (id) revealInTabs(id)
}

/** Show the neighbouring tab, wrapping around. */
export function stepTab(by: 1 | -1): void {
  const { active } = getTabLayout().tabs
  const order = tabModeOrder()
  if (!inTabs() || !order.length) return
  const i = order.indexOf(active ?? '')
  revealInTabs(order[i < 0 ? (by > 0 ? 0 : order.length - 1) : (i + by + order.length) % order.length])
}

/** The layout commands for the current mode (pure; tests read it without React). */
export function tabLayoutCommands(closeActive: () => void, tabsMode: boolean, isMac: boolean): Command[] {
  const toggle: Command = { id: TOGGLE_LAYOUT_ID, label: 'View: Toggle Tab Layout', defaultKey: TOGGLE_LAYOUT_KEY, run: toggleLayoutMode }
  const nodeTabs: Command = { id: TOGGLE_NODE_TABS_ID, label: 'View: Toggle Node Tabs', run: toggleNodeTabs }
  if (!tabsMode) return [toggle, nodeTabs]
  return [
    toggle, nodeTabs,
    ...Array.from({ length: 9 }, (_, i): Command => ({ id: `tab.goto.${i + 1}`, label: `Tab: Go to Tab ${i + 1}`, defaultKey: `Mod+${i + 1}`, hidden: true, run: () => gotoTab(i + 1) })),
    { id: 'tab.prev', label: 'Tab: Previous Tab', defaultKey: PREV_TAB_KEY, run: () => stepTab(-1) },
    { id: 'tab.next', label: 'Tab: Next Tab', defaultKey: NEXT_TAB_KEY, run: () => stepTab(1) },
    { id: 'tab.close', label: 'Tab: Close Active Tab', defaultKey: closeTabKey(isMac), run: closeActive },
  ]
}

/** Registers the layout commands while App is mounted; `closeNode` is the same close path as the tab's × button. */
export function useTabLayoutCommands(closeNode: (id: string) => void): void {
  const tabsMode = useTabLayout().mode === 'tabs'
  const close = useRef(closeNode)
  close.current = closeNode
  const list = useMemo(() => tabLayoutCommands(() => {
    const id = getTabLayout().tabs.active
    if (id) close.current(id)
  }, tabsMode, isMacPlatform()), [tabsMode])
  useRegisterCommands(list)
}
