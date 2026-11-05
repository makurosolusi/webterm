/**
 * @vitest-environment jsdom
 */
// Regression: React Flow's d3-zoom pane stopImmediatePropagation()s `mousedown`, so click-outside
// dismissal on a bubble-phase document listener never fired for a canvas click (only for nodes).
// `pane` below plays the pane; every outside-click popup must still close when it is clicked.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Omnibox from './Omnibox'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import { VscodeMenuBar } from './components/vscode/vscodeMenuBar'
import { VscodeQuickPick } from './components/vscode/vscodeQuickPick'

afterEach(cleanup)

function pane(): HTMLElement {
  const el = document.createElement('div')
  el.addEventListener('mousedown', (e) => e.stopImmediatePropagation())
  document.body.appendChild(el)
  return el
}

describe('click outside through the canvas pane', () => {
  it('closes the quick pick', () => {
    const onClose = vi.fn()
    render(<VscodeQuickPick open onClose={onClose} onSelect={() => {}} placeholder="Pick" items={[{ id: 'a', label: 'Alpha' }]} />)
    fireEvent.mouseDown(pane())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the omnibox, but not on a click inside it', () => {
    const onClose = vi.fn()
    const sources = { nodes: [], commands: [], agents: [], recentUrls: [], asUrl: () => null }
    render(<Omnibox scope="all" root="/w" sources={sources} onAction={() => {}} onClose={onClose} />)
    fireEvent.mouseDown(screen.getByRole('combobox'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(pane())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes an open menu bar menu', () => {
    const onOpenChange = vi.fn()
    render(<VscodeMenuBar menus={[{ id: 'file', label: 'File', items: [{ id: 'new', label: 'New' }] }]} openId="file" onOpenChange={onOpenChange} />)
    fireEvent.mouseDown(pane())
    expect(onOpenChange).toHaveBeenCalledWith(null)
  })

  it('closes the breadcrumbs overflow menu', () => {
    const segments = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, onClick: () => {} }))
    render(<VscodeBreadcrumbs segments={segments} maxVisible={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden path segments' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.mouseDown(pane())
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
