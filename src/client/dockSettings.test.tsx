/**
 * @vitest-environment jsdom
 */
// Pintasan Settings di activity bar (slot tepat di bawah "Add node"): membuka dialog modal yang sama
// dengan File > Settings…, jadi ia tidak boleh tampil sebagai panel "terpilih".
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dock, { type DockProps } from './Dock'

const noop = () => {}
const baseProps: DockProps = {
  onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
  onUndo: noop, onRedo: noop, canUndo: false, canRedo: false,
  onBack: noop, onForward: noop, canBack: false, canForward: false,
  onFit: noop, onToggleBoard: noop, sessionsOpen: false, onToggleSessions: noop,
  inboxOpen: false, onToggleInbox: noop, zoomPct: 100, onZoomIn: noop, onZoomOut: noop,
  locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop,
}

afterEach(cleanup)

describe('pintasan Settings di activity bar', () => {
  it('ada tepat setelah Add node dan klik memanggil handler sekali', () => {
    const onOpenSettings = vi.fn()
    render(<Dock {...baseProps} onOpenSettings={onOpenSettings} />)
    const labels = Array.from(document.querySelectorAll('.vscode-activity-bar__item')).map((b) => b.getAttribute('aria-label'))
    expect(labels.indexOf('Settings')).toBe(labels.indexOf('Add node') + 1)

    const btn = screen.getByLabelText('Settings')
    expect(btn.getAttribute('title')).toBe('Settings')
    expect(btn.querySelector('.codicon-settings-gear')).not.toBeNull()
    fireEvent.click(btn)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('tidak dirender bila handler tak diberikan', () => {
    render(<Dock {...baseProps} />)
    expect(screen.queryByLabelText('Settings')).toBeNull()
  })

  it('tidak pernah ditandai aktif, bahkan saat panel lain terbuka', () => {
    render(<Dock {...baseProps} sessionsOpen onOpenSettings={noop} />)
    const btn = screen.getByLabelText('Settings')
    expect(btn.hasAttribute('aria-current')).toBe(false)
    expect(btn.getAttribute('data-active')).toBe('false')
    expect(screen.getByLabelText('Toggle sessions panel').getAttribute('aria-current')).toBe('page')
  })
})
