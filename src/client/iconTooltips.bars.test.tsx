/**
 * @vitest-environment jsdom
 */
// The bars migrated to IconButton / IconTooltip: activity bar, canvas toolbar, status bar. Each
// icon-only control has a role-queryable name and a visible tooltip (no native `title`).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dock, { type DockProps } from './Dock'
import CanvasToolbar from './CanvasToolbar'

const noop = () => {}
const dockProps: DockProps = {
  onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
  onUndo: noop, onRedo: noop, canUndo: false, canRedo: true,
  onBack: noop, onForward: noop, canBack: false, canForward: false,
  onFit: noop, onToggleBoard: noop, sessionsOpen: false, onToggleSessions: noop,
  inboxOpen: false, onToggleInbox: noop, zoomPct: 100, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop,
  locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop, onOpenSettings: noop,
  inboxUnread: 2,
}

const tipOf = (el: Element): string | null | undefined => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.blur(el)
  return text
}

afterEach(cleanup)

describe('activity bar', () => {
  it('exposes every entry by name and shows its tooltip', () => {
    render(<Dock {...dockProps} />)
    for (const name of ['Toggle sessions panel', 'Toggle inbox panel, 2', 'Toggle central control panel', 'Board', 'Add node', 'Settings', 'Lock view', 'Clean view']) {
      const btn = screen.getByRole('button', { name })
      expect(btn.hasAttribute('title'), name).toBe(false)
    }
    expect(tipOf(screen.getByRole('button', { name: 'Toggle inbox panel, 2' }))).toBe('Toggle inbox panel (2 unread)')
    expect(tipOf(screen.getByRole('button', { name: 'Board' }))).toBe('Toggle Kanban board')
  })

  it('toggle tooltips state the current state and the click action', () => {
    const { rerender } = render(<Dock {...dockProps} />)
    expect(tipOf(screen.getByRole('button', { name: 'Lock view' }))).toBe('View unlocked. Click to lock pan and zoom; nodes stay movable')
    rerender(<Dock {...dockProps} locked />)
    expect(tipOf(screen.getByRole('button', { name: 'Unlock view' }))).toBe('View locked: pan and zoom are off. Click to unlock')
    expect(tipOf(screen.getByRole('button', { name: 'Clean view' }))).toMatch(/^Clean view is off\. Click to hide all chrome/)
  })
})

describe('status bar', () => {
  it('exposes canvas actions by name; disabled ones stay focusable and say why', () => {
    render(<Dock {...dockProps} />)
    for (const name of ['Undo', 'Redo', 'Go back', 'Go forward', 'Fit view', 'Zoom out', 'Zoom presets', 'Zoom in']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    expect(tipOf(undo.parentElement!)).toBe('Undo last canvas change (nothing to undo)')
    expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(false)
    expect(tipOf(screen.getByRole('button', { name: 'Zoom presets' }))).toBe('Zoom 100% — choose a preset')
  })

  it('shows extra status items (problems, tasks) with explanatory tooltips', () => {
    render(<Dock {...dockProps} extraStatusItems={[
      { id: 'problems', label: '0 / 2', tooltip: '0 errors, 2 warnings from the type checker and linter — toggle Problems', ariaLabel: 'Problems: 0 errors, 2 warnings', onClick: noop },
    ]} />)
    expect(tipOf(screen.getByRole('button', { name: 'Problems: 0 errors, 2 warnings' }))).toMatch(/2 warnings .* toggle Problems/)
  })
})

describe('canvas toolbar', () => {
  it('names each button after what its click does', () => {
    const props = { onOpenExplorer: vi.fn(), onOpenSettings: vi.fn(), onOpenHelp: vi.fn() }
    render(<CanvasToolbar nodes={[]} onFocusNode={noop} platform="MacIntel" {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Files node' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(props.onOpenExplorer).toHaveBeenCalledTimes(1)
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(props.onOpenHelp).toHaveBeenCalledTimes(1)
    expect(tipOf(screen.getByRole('button', { name: 'Command palette' }))).toBe('Command palette ⌘K')
  })
})
