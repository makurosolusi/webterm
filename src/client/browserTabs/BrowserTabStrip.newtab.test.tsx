/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MAX_TABS_PER_NODE } from '../../shared/browser.tabs'
import { fakeOverflow, makeState, renderStrip } from './browserTabsHarness'

const plus = () => screen.getByRole('button', { name: 'New tab' })
const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('BrowserTabStrip New tab placement', () => {
  it('sits right after the tab list, before the spacer and the trailing controls, and is not a tab', () => {
    renderStrip(makeState(['a', 'b']), { trailing: <button type="button">Split</button> })
    const list = screen.getByRole('tablist')
    const spacer = document.querySelector('.bt-spacer') as Element
    expect(follows(list, plus())).toBe(true)
    expect(list.contains(plus())).toBe(false)
    expect(plus().getAttribute('role')).not.toBe('tab')
    expect(follows(plus(), spacer)).toBe(true)
    expect(follows(plus(), screen.getByRole('button', { name: 'Split' }))).toBe(true)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('stays next to the list (outside the scroller) while tabs overflow, before the chevron and All tabs', () => {
    renderStrip(makeState(['a', 'b', 'c']))
    const list = screen.getByRole('tablist')
    act(() => { fakeOverflow(list, 900, 300, 0); fireEvent.scroll(list) })
    expect(list.contains(plus())).toBe(false)
    expect(follows(list, plus())).toBe(true)
    expect(follows(plus(), screen.getByRole('button', { name: 'Scroll tabs right' }))).toBe(true)
    expect(follows(plus(), screen.getByRole('button', { name: 'All tabs' }))).toBe(true)
  })

  it('is disabled at the limit with a visible reason and creates nothing', () => {
    const { onAction } = renderStrip(makeState(Array.from({ length: MAX_TABS_PER_NODE }, (_, i) => `t${i}`)))
    expect((plus() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Tab limit (8) reached')
    fireEvent.click(plus())
    expect(onAction).not.toHaveBeenCalled()
  })

  it('double-click on the empty strip still creates a tab', () => {
    const { onAction } = renderStrip(makeState(['a']))
    fireEvent.doubleClick(document.querySelector('.bt-spacer') as Element)
    expect(onAction).toHaveBeenCalledWith({ type: 'new', newTabId: 'new1', afterTabId: undefined })
  })
})
