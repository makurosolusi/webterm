/** @vitest-environment jsdom */
// Tab mode: the bottom panel takes space from the tab area instead of covering it. jsdom has no
// layout, so this pins the contract (selector + variable); real geometry is checked in a browser.
import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import BottomPanelHost, { type BottomPanelView } from './bottomPanelHost'

afterEach(cleanup)

const view = (open: boolean): BottomPanelView => ({ id: 'v', label: 'V', open, onClose: () => undefined, render: () => <i /> })
const css = readFileSync(`${process.cwd()}/src/client/tab-layout.css`, 'utf8')
const TABS_RULE = /\.app-shell:has\(> \.bottom-panel-host\) \.tabs-view\s*\{([^}]*)\}/

describe('bottom panel in tab mode', () => {
  it('the host is a direct child of the shell only while a view is open', () => {
    const { container, rerender } = render(<div className="app-shell"><BottomPanelHost views={[view(true)]} /></div>)
    const shell = container.firstElementChild!
    expect(shell.matches('.app-shell:has(> .bottom-panel-host)')).toBe(true)
    rerender(<div className="app-shell"><BottomPanelHost views={[view(false)]} /></div>)
    expect(shell.matches('.app-shell:has(> .bottom-panel-host)')).toBe(false)
  })

  it('shrinks .tabs-view by the panel height variable, and leaves the canvas overlay alone', () => {
    expect(TABS_RULE.exec(css)![1]).toContain('bottom: var(--bottom-panel-h)')
    expect(css).not.toMatch(/bottom-panel[^{]*\.board-host/)
    expect(css).not.toContain('!important')
  })
})
