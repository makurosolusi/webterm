// REST client for one node's tabs (`/api/browser/:nodeId/tabs`). Every answer is the node's whole tab list plus the
// tab (or node) the action made, so callers replace their state with `state` instead of patching it.
import { request } from '../browser.api'
import type { BrowserTab, BrowserTabsState } from '../../shared/browser.tabs'

export interface TabsView { state: BrowserTabsState; tab?: BrowserTab; newNodeId?: string }

const base = (nodeId: string): string => `/${encodeURIComponent(nodeId)}/tabs`
const one = (nodeId: string, tabId: string): string => `${base(nodeId)}/${encodeURIComponent(tabId)}`

export const tabsApi = {
  list: (nodeId: string) => request<TabsView>('GET', base(nodeId)),
  create: (nodeId: string, body: { url?: string; afterTabId?: string }) => request<TabsView>('POST', base(nodeId), body),
  activate: (nodeId: string, tabId: string) => request<TabsView>('POST', `${one(nodeId, tabId)}/activate`),
  close: (nodeId: string, tabId: string) => request<TabsView>('DELETE', one(nodeId, tabId)),
  move: (nodeId: string, tabId: string, toIndex: number) => request<TabsView>('POST', `${one(nodeId, tabId)}/move`, { toIndex }),
  duplicate: (nodeId: string, tabId: string) => request<TabsView>('POST', `${one(nodeId, tabId)}/duplicate`),
  popOut: (nodeId: string, tabId: string) => request<TabsView>('POST', `${one(nodeId, tabId)}/pop-out`),
  reopen: (nodeId: string) => request<TabsView>('POST', `${base(nodeId)}/reopen`),
}
