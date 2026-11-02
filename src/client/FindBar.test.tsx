/** @vitest-environment jsdom */
// Find widget: kontrak keyboard VS Code (Enter / Shift+Enter / Esc) dan penanda ARIA/ikon.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import FindBar from './FindBar'

afterEach(cleanup)

describe('FindBar', () => {
  it('memakai ikon codicon dan judul bersertakan shortcut', () => {
    const { container } = render(<FindBar onSearch={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('[role="search"]')?.getAttribute('aria-label')).toBe('Find')
    const btns = [...container.querySelectorAll('vscode-toolbar-button')]
    expect(btns.map((b) => b.querySelector('.codicon')?.className)).toEqual([
      'codicon codicon-arrow-up', 'codicon codicon-arrow-down', 'codicon codicon-close',
    ])
    expect(btns.map((b) => b.getAttribute('data-title'))).toEqual([
      'Previous Match (Shift+Enter)', 'Next Match (Enter)', 'Close (Escape)',
    ])
  })

  it('Enter = next, Shift+Enter = prev, Esc = tutup', () => {
    const onSearch = vi.fn()
    const onClose = vi.fn()
    const { container } = render(<FindBar onSearch={onSearch} onClose={onClose} />)
    const field = container.querySelector('vscode-textfield')!
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onSearch.mock.calls).toEqual([['', 'next'], ['', 'prev']])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
