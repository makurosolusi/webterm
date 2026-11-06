/** @vitest-environment jsdom */
// Canvas mode: the bottom panel is docked, so the board and Welcome end where it starts. jsdom has
// no layout, so this pins the contract (selector + variable); real geometry is checked in a browser.
import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import BottomPanelHost, { type BottomPanelView } from './bottomPanelHost'

afterEach(cleanup)

const read = (name: string) => readFileSync(`${process.cwd()}/src/client/${name}`, 'utf8')
const tabCss = read('tab-layout.css')
const surfaceCss = read('inboxPanelSurface.css')
const view = (open: boolean): BottomPanelView => ({ id: 'v', label: 'V', open, onClose: () => undefined, render: () => <i /> })
const DOCK_RULE = /([^{}]*)\{\s*bottom: var\(--bottom-panel-h\);\s*\}/

describe('docked bottom panel in canvas mode', () => {
  it('the dock rule covers the canvas board and Welcome while any panel surface is a shell child', () => {
    const selector = DOCK_RULE.exec(tabCss)![1]
    expect(selector).toContain(".app-shell:has(> .vscode-bottom-panel) .board-host[data-mode='canvas']")
    expect(selector).toContain('.app-shell:has(> .vscode-bottom-panel) .welcome')
  })

  it('the panel and the dock share the status-bar edge and the height variable, so maximize and sash track', () => {
    const panel = /\.vscode-bottom-panel\s*\{([^}]*)\}/.exec(surfaceCss)![1]
    expect(panel).toContain('bottom: var(--status-bar-h')
    expect(panel).toContain('height: var(--bottom-panel-h)')
    expect(surfaceCss).toMatch(/\.vscode-bottom-panel\[data-maximized='true'\]\s*\{\s*height: 80vh;/)
  })

  it('an open BottomPanelHost matches the dock selectors for a board sibling, and a closed one does not', () => {
    const tree = (open: boolean) => (
      <div className="app-shell">
        <div className="app-main"><div className="board-host" data-mode="canvas" /></div>
        <BottomPanelHost views={[view(open)]} />
      </div>
    )
    const { container, rerender } = render(tree(true))
    const board = container.querySelector('.board-host')!
    expect(board.matches(".app-shell:has(> .vscode-bottom-panel) .board-host[data-mode='canvas']")).toBe(true)
    rerender(tree(false))
    expect(board.matches(".app-shell:has(> .vscode-bottom-panel) .board-host[data-mode='canvas']")).toBe(false)
  })
})
