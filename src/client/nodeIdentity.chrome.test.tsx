/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import NodeChrome from './NodeChrome'

afterEach(cleanup)

const base = {
  title: 'brisk-otter', onRename: () => {}, collapsed: false, onToggleCollapse: () => {},
  color: '#0a84ff', onColor: () => {}, comments: [], onAddComment: () => {}, onRefresh: () => {},
  searchOpen: false, onToggleSearch: () => {}, onClose: () => {},
}

describe('node identity in the chrome', () => {
  it('shows a Stop button only when wired, and it calls onStop (not onClose)', () => {
    const a = render(<NodeChrome {...base} />)
    expect(a.container.querySelector('[data-title="Stop Agent (keeps the node)"]')).toBeNull()
    a.unmount()
    const onStop = vi.fn(); const onClose = vi.fn()
    const b = render(<NodeChrome {...base} onStop={onStop} onClose={onClose} />)
    fireEvent.click(b.container.querySelector('[data-title="Stop Agent (keeps the node)"]') as Element)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('has no unexplained coloured marks before the title (no hashed identity square, no colour dot)', () => {
    const { container } = render(<NodeChrome {...base} icon="hubot" />)
    expect(container.querySelector('.node-identity')).toBeNull()
    expect(container.querySelector('.node-swatch__dot')).toBeNull()
    expect([...container.querySelectorAll('.node-header [style*="background"]')]).toHaveLength(0)
  })

  it('shows the name first and the label muted after it; Rename edits the title, never the name', () => {
    const onRename = vi.fn()
    const { container } = render(<NodeChrome {...base} name="Mango" title="Agent Chat" onRename={onRename} />)
    const title = container.querySelector('.node-title') as HTMLElement
    expect(title.textContent).toBe('Mango · Agent Chat')
    expect(title.querySelector('.node-name')?.textContent).toBe('Mango')
    expect(title.querySelector('.node-name__label')?.textContent).toBe(' · Agent Chat')
    fireEvent.click(title)
    // Committing the untouched draft renames to the title alone: the draft never holds the name.
    fireEvent.keyDown(container.querySelector('.node-title--edit') as Element, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('Agent Chat')
  })

  it('a named node with no label shows just the name; an unnamed one keeps Untitled', () => {
    const a = render(<NodeChrome {...base} name="Mango" title="" />)
    expect(a.container.querySelector('.node-title')?.textContent).toBe('Mango')
    a.unmount()
    const b = render(<NodeChrome {...base} title="" />)
    expect(b.container.querySelector('.node-title')?.textContent).toBe('Untitled')
  })
})
