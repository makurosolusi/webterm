// Test harness for the browser tab components (jsdom): tab/state factories and a strip renderer with a spy.
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { BrowserTab, BrowserTabsState } from '../../shared/browser.tabs'
import { BrowserTabStrip } from './BrowserTabStrip'

export const makeTab = (tabId: string, extra: Partial<BrowserTab> = {}): BrowserTab =>
  ({ tabId, title: `Title ${tabId}`, url: `https://${tabId}.example.com/page`, loading: false, discarded: false, crashed: false, ...extra })

export const makeState = (ids: string[], over: Partial<BrowserTabsState> = {}): BrowserTabsState =>
  ({ tabs: ids.map((i) => makeTab(i)), activeTabId: ids[0] ?? null, agentTabId: ids[0] ?? null, closed: [], ...over })

export function renderStrip(state: BrowserTabsState, props: Partial<React.ComponentProps<typeof BrowserTabStrip>> = {}) {
  const onAction = vi.fn()
  const onNotice = vi.fn()
  let n = 0
  const makeId = () => `new${++n}`
  const utils = render(<BrowserTabStrip state={state} onAction={onAction} onNotice={onNotice} makeId={makeId} {...props} />)
  return { ...utils, onAction, onNotice }
}

/** Pretends the scroller is `scrollWidth` wide inside `clientWidth` (jsdom has no layout). */
export function fakeOverflow(list: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  Object.defineProperty(list, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(list, 'clientWidth', { configurable: true, value: clientWidth })
  Object.defineProperty(list, 'scrollLeft', { configurable: true, writable: true, value: scrollLeft })
}
