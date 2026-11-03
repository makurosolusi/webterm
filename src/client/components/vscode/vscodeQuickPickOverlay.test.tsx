/**
 * @vitest-environment jsdom
 */
// Quick Pick harus lolos dari stacking context pemanggilnya (di `.dock` z-index-nya kalah dari
// titlebar/tab bar) dan dismiss-nya tidak boleh bentrok dengan tombol pembukanya.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VscodeQuickPick } from './vscodeQuickPick'

afterEach(cleanup)

const items = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]

function setup(props: Partial<React.ComponentProps<typeof VscodeQuickPick>> = {}) {
  const onClose = vi.fn()
  const onSelect = vi.fn()
  const view = render(
    <div id="host" style={{ position: 'relative', zIndex: 20 }}>
      <button type="button" data-testid="opener">+</button>
      <VscodeQuickPick open onClose={onClose} onSelect={onSelect} placeholder="Pick" items={items} {...props} />
    </div>,
  )
  return { onClose, onSelect, view }
}

describe('VscodeQuickPick overlay', () => {
  it('dirender lewat portal ke body, bukan di dalam induk bergaya stacking context', () => {
    setup()
    const dialog = screen.getByRole('dialog')
    expect(dialog.parentElement).toBe(document.body)
    expect(document.getElementById('host')?.contains(dialog)).toBe(false)
  })

  it('Escape menutup', () => {
    const { onClose } = setup()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('mousedown di luar menutup, di dalam tidak', () => {
    const { onClose } = setup()
    fireEvent.mouseDown(screen.getByRole('combobox'))
    fireEvent.mouseDown(screen.getByText('Alpha'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('mousedown pada pemicu (triggerSelector) tidak dihitung "di luar"', () => {
    const { onClose } = setup({ triggerSelector: '[data-testid="opener"]' })
    fireEvent.mouseDown(screen.getByTestId('opener'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('klik baris memilih item', () => {
    const { onSelect } = setup()
    fireEvent.click(screen.getByText('Beta'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })
})
