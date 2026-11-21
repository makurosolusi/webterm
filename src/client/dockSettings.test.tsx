/**
 * @vitest-environment jsdom
 */
// Pintasan Settings di grup bawah rail (di atas Lock view, ala "Manage" VS Code): membuka dialog modal yang sama
// dengan File > Settings…, jadi ia tidak boleh tampil sebagai panel "terpilih".
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dock, { type DockProps } from './Dock'

const noop = () => {}
const baseProps: DockProps = {
  onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
  onUndo: noop, onRedo: noop, canUndo: false, canRedo: false,
  onBack: noop, onForward: noop, canBack: false, canForward: false,
  onFit: noop, onToggleBoard: noop, sideBarOpen: false, sideBarView: 'layers', onSideBarView: noop,
  zoomPct: 100, onZoomIn: noop, onZoomOut: noop,
  locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop,
}

afterEach(cleanup)

describe('pintasan Settings di activity bar', () => {
  it('ada di grup bawah, bukan di <nav>, dan klik memanggil handler sekali', () => {
    const onOpenSettings = vi.fn()
    render(<Dock {...baseProps} onOpenSettings={onOpenSettings} />)
    const btn = screen.getByLabelText('Settings')
    expect(btn.closest('[data-slot="dock-modes"]')).not.toBeNull()
    expect(btn.closest('nav')).toBeNull()
    expect(btn.hasAttribute('title')).toBe(false)
    fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
    fireEvent.focus(btn)
    expect(screen.getByRole('tooltip').textContent).toContain('Settings')
    expect(btn.querySelector('.codicon-settings-gear')).not.toBeNull()
    fireEvent.click(btn)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('urutan grup bawah: settings, lock, screenshot, clean view', () => {
    render(<Dock {...baseProps} onOpenSettings={noop} />)
    const group = document.querySelector('[data-slot="dock-modes"]')!
    expect(Array.from(group.children).map((b) => b.getAttribute('aria-label')))
      .toEqual(['Settings', 'Lock view', 'Take screenshot', 'Clean view'])
  })

  it('Settings bukan toggle; lock dan clean view tetap ber-aria-pressed', () => {
    render(<Dock {...baseProps} onOpenSettings={noop} />)
    expect(screen.getByLabelText('Settings').hasAttribute('aria-pressed')).toBe(false)
    expect(screen.getByLabelText('Lock view').hasAttribute('aria-pressed')).toBe(true)
    expect(screen.getByLabelText('Clean view').hasAttribute('aria-pressed')).toBe(true)
  })

  it('tidak dirender bila handler tak diberikan', () => {
    render(<Dock {...baseProps} />)
    expect(screen.queryByLabelText('Settings')).toBeNull()
    expect(document.querySelector('[data-slot="dock-modes"]')!.children).toHaveLength(3)
  })

  it('tidak pernah ditandai aktif, bahkan saat panel lain terbuka', () => {
    render(<Dock {...baseProps} sideBarOpen sideBarView="sessions" onOpenSettings={noop} />)
    const btn = screen.getByLabelText('Settings')
    expect(btn.hasAttribute('aria-current')).toBe(false)
    expect(btn.hasAttribute('data-active')).toBe(false)
    expect(screen.getByLabelText('Sessions').getAttribute('aria-current')).toBe('page')
  })
})
