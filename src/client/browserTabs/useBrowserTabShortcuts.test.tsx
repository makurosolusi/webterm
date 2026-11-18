/**
 * @vitest-environment jsdom
 */
import { useRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MAX_TABS_PER_NODE, type BrowserTabsState } from '../../shared/browser.tabs'
import { makeState, makeTab } from './browserTabsHarness'
import { belongsToOtherEditor, tabShortcut, useBrowserTabShortcuts } from './useBrowserTabShortcuts'

const key = (over: Partial<KeyboardEvent>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })

describe('tabShortcut', () => {
  it('maps the Windows/Linux chords', () => {
    expect(tabShortcut(key({ ctrlKey: true, code: 'KeyT' }), false)).toEqual({ kind: 'new' })
    expect(tabShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyT' }), false)).toEqual({ kind: 'reopen' })
    expect(tabShortcut(key({ ctrlKey: true, code: 'KeyW' }), false)).toEqual({ kind: 'close' })
    expect(tabShortcut(key({ ctrlKey: true, code: 'Digit3' }), false)).toEqual({ kind: 'index', n: 3 })
    expect(tabShortcut(key({ ctrlKey: true, key: 'Tab' }), false)).toEqual({ kind: 'cycle', dir: 1 })
    expect(tabShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }), false)).toEqual({ kind: 'cycle', dir: -1 })
  })
  it('uses Cmd on macOS but Ctrl+Tab everywhere', () => {
    expect(tabShortcut(key({ metaKey: true, code: 'KeyT' }), true)).toEqual({ kind: 'new' })
    expect(tabShortcut(key({ ctrlKey: true, code: 'KeyT' }), true)).toBeNull()
    expect(tabShortcut(key({ ctrlKey: true, key: 'Tab' }), true)).toEqual({ kind: 'cycle', dir: 1 })
  })
  it('ignores Alt chords, plain keys, digit 9/0 and Shift+W', () => {
    expect(tabShortcut(key({ ctrlKey: true, altKey: true, code: 'KeyT' }), false)).toBeNull()
    expect(tabShortcut(key({ code: 'KeyT' }), false)).toBeNull()
    expect(tabShortcut(key({ ctrlKey: true, code: `Digit${MAX_TABS_PER_NODE + 1}` }), false)).toBeNull()
    expect(tabShortcut(key({ ctrlKey: true, code: 'Digit0' }), false)).toBeNull()
    expect(tabShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyW' }), false)).toBeNull()
  })
})

function Host({ state, onAction, onNotice, children }: { state: BrowserTabsState; onAction: (a: unknown) => void; onNotice?: (t: string) => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useBrowserTabShortcuts({ containerRef: ref, state, onAction, onNotice, makeId: () => 'nid' })
  return (
    <div>
      <div ref={ref} data-testid="node" tabIndex={0}>
        <div className="xterm"><textarea aria-label="xterm input" /></div>
        <input aria-label="notes" />
        <input aria-label="omnibox" data-browser-omnibox />
        <div role="tab" tabIndex={0} aria-label="a tab" />
        {children}
      </div>
      <button>outside</button>
    </div>
  )
}
const setup = (state = makeState(['a', 'b', 'c'], { activeTabId: 'b' })) => {
  const onAction = vi.fn()
  const onNotice = vi.fn()
  render(<Host state={state} onAction={onAction} onNotice={onNotice} />)
  return { onAction, onNotice }
}
const press = (el: Element, init: KeyboardEventInit) => fireEvent.keyDown(el, init)
const node = () => screen.getByTestId('node')

describe('useBrowserTabShortcuts', () => {
  it('Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+digit and Ctrl+Shift+T run while focus is in the node', () => {
    const { onAction } = setup(makeState(['a', 'b', 'c'], { activeTabId: 'b', closed: [makeTab('z')] }))
    press(node(), { ctrlKey: true, code: 'KeyT' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'new', newTabId: 'nid' })
    press(node(), { ctrlKey: true, code: 'KeyW' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'close', tabId: 'b' })
    press(node(), { ctrlKey: true, key: 'Tab' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'activate', tabId: 'c' })
    press(node(), { ctrlKey: true, shiftKey: true, key: 'Tab' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'activate', tabId: 'a' })
    press(node(), { ctrlKey: true, code: 'Digit3' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'activate', tabId: 'c' })
    press(node(), { ctrlKey: true, shiftKey: true, code: 'KeyT' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'reopenClosed', newTabId: 'nid' })
  })

  it('wraps Ctrl+Tab around both ends', () => {
    const { onAction } = setup(makeState(['a', 'b', 'c'], { activeTabId: 'c' }))
    press(node(), { ctrlKey: true, key: 'Tab' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'activate', tabId: 'a' })
  })

  it('consumes handled chords (default prevented) but not Ctrl+digit with no such tab', () => {
    const { onAction } = setup(makeState(['a', 'b']))
    expect(press(node(), { ctrlKey: true, code: 'KeyT', cancelable: true })).toBe(false)
    expect(press(node(), { ctrlKey: true, code: 'Digit7', cancelable: true })).toBe(true)
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('does nothing outside the node', () => {
    const { onAction } = setup()
    press(screen.getByText('outside'), { ctrlKey: true, code: 'KeyT' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('does not capture inside xterm or another text input, but does in the address field', () => {
    const { onAction } = setup()
    press(screen.getByLabelText('xterm input'), { ctrlKey: true, code: 'KeyT' })
    press(screen.getByLabelText('notes'), { ctrlKey: true, code: 'KeyT' })
    expect(onAction).not.toHaveBeenCalled()
    press(screen.getByLabelText('omnibox'), { ctrlKey: true, code: 'KeyT' })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(belongsToOtherEditor(screen.getByLabelText('notes'))).toBe(true)
    expect(belongsToOtherEditor(null)).toBe(false)
  })

  it('leaves Ctrl+W on a focused tab to the strip', () => {
    const { onAction } = setup()
    press(screen.getByRole('tab', { name: 'a tab' }), { ctrlKey: true, code: 'KeyW' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('at the limit Ctrl+T and Ctrl+Shift+T explain instead of acting; reopen with empty history says so', () => {
    const full = makeState(Array.from({ length: MAX_TABS_PER_NODE }, (_, i) => `t${i}`), { closed: [makeTab('z')] })
    const a = setup(full)
    press(node(), { ctrlKey: true, code: 'KeyT' })
    expect(a.onAction).not.toHaveBeenCalled()
    expect(a.onNotice).toHaveBeenCalledWith('Tab limit (8) reached')
  })

  it('reports an empty closed history', () => {
    const { onAction, onNotice } = setup()
    press(node(), { ctrlKey: true, shiftKey: true, code: 'KeyT' })
    expect(onAction).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith('No recently closed tabs')
  })

  it('closing with no active tab does nothing', () => {
    const { onAction } = setup(makeState([], { activeTabId: null }))
    press(node(), { ctrlKey: true, code: 'KeyW' })
    expect(onAction).not.toHaveBeenCalled()
  })
})
