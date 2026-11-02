/** @vitest-environment jsdom */
// Render Kanban: kolom bergaya list VS Code, kartu bisa diklik, Close/Escape menutup.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import Kanban from './Kanban'

afterEach(cleanup)

const nodes = [{ id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { kind: 'agent', title: 'Refactor' } }]

describe('Kanban render', () => {
  it('memuat empat kolom dengan ikon codicon dan memfokuskan kartu saat diklik', () => {
    const onFocus = vi.fn()
    const { container } = render(<Kanban nodes={nodes} statuses={{ a1: 'working' }} onFocus={onFocus} onClose={vi.fn()} />)
    expect(container.querySelectorAll('.kanban-column')).toHaveLength(4)
    expect(container.querySelectorAll('.kanban-column .codicon-circle-filled')).toHaveLength(4)
    fireEvent.click(container.querySelector('.kanban-column button')!)
    expect(onFocus).toHaveBeenCalledWith('a1')
  })

  it('kolom tanpa kartu menampilkan empty state dan badge persegi (bukan pill)', () => {
    const { container } = render(<Kanban nodes={nodes} statuses={{ a1: 'working' }} onFocus={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getAllByText('No agents')).toHaveLength(3)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('left-[var(--activity-bar-w,0px)]')
    expect(root.className).toContain('bottom-[var(--status-bar-h,0px)]')
    expect(container.innerHTML).not.toContain('rounded-full')
  })

  it('Escape menutup overlay', () => {
    const onClose = vi.fn()
    render(<Kanban nodes={[]} statuses={{}} onFocus={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Board')).toBeTruthy()
  })
})
