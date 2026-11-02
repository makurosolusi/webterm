/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HelpOverlay from './HelpOverlay'

afterEach(cleanup)

describe('HelpOverlay', () => {
  it('renders a labelled Keyboard Shortcuts dialog with a Command / Keybinding table', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux x86_64" />)
    expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Command', 'Keybinding'])
    expect(screen.getAllByRole('row')).toHaveLength(10)
  })

  it('draws Ctrl+K as separate kbd chips on non-mac platforms', () => {
    render(<HelpOverlay onClose={() => {}} platform="Win32" />)
    const row = screen.getByText('Cari node (command palette)').closest('tr') as HTMLElement
    expect(Array.from(row.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['Ctrl', 'K'])
    expect(row.textContent).toContain('+')
  })

  it('uses symbol chips without plus signs on macOS', () => {
    render(<HelpOverlay onClose={() => {}} platform="MacIntel" />)
    const row = screen.getByText('Baris baru tanpa mengirim, di dalam terminal').closest('tr') as HTMLElement
    expect(Array.from(row.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['⇧', 'Enter'])
    expect(row.textContent).not.toContain('+')
  })

  it('shows gestures as plain text, not chips', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux" />)
    const row = screen.getByText('Hapus link context itu').closest('tr') as HTMLElement
    expect(row.querySelectorAll('kbd')).toHaveLength(0)
    expect(row.textContent).toContain('Dobel-klik edge')
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    render(<HelpOverlay onClose={onClose} platform="Linux" />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    onClose.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
