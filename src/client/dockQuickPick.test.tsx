/**
 * @vitest-environment jsdom
 */
// Tombol "+" (Add node) harus benar-benar toggle: mousedown+click pada tombol yang sama menutup
// Quick Pick, bukan menutup lalu membukanya lagi.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

const press = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el) }

describe('Quick Pick "Add node" di Dock', () => {
  it('tombol + membuka, lalu menekannya lagi menutup', () => {
    render(<Dock {...baseProps} />)
    const plus = screen.getByRole('button', { name: 'Add node' })
    press(plus)
    expect(screen.getByRole('dialog', { name: 'Add node' })).toBeTruthy()
    press(plus)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape dan mousedown di luar menutup', () => {
    render(<Dock {...baseProps} />)
    press(screen.getByRole('button', { name: 'Add node' }))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    press(screen.getByRole('button', { name: 'Add node' }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
