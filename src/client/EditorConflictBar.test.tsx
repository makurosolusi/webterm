/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { EditorConflictBar } from './EditorConflictBar'

afterEach(cleanup)

describe('EditorConflictBar', () => {
  it('versi: Reload dan Overwrite memanggil callback masing-masing', () => {
    const onReload = vi.fn(), onOverwrite = vi.fn()
    render(<EditorConflictBar conflict={{ kind: 'version', current: 'v2' }} fileName="a.ts" onReload={onReload} onOverwrite={onOverwrite} />)
    expect(screen.getByRole('alert').textContent).toContain('a.ts changed on disk')
    fireEvent.click(screen.getByText('Reload'))
    fireEvent.click(screen.getByText('Overwrite'))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onOverwrite).toHaveBeenCalledTimes(1)
  })

  it('missing: pesan terhapus, tanpa Reload, tombol Recreate', () => {
    const onOverwrite = vi.fn()
    render(<EditorConflictBar conflict={{ kind: 'missing' }} fileName="a.ts" onReload={vi.fn()} onOverwrite={onOverwrite} />)
    expect(screen.getByRole('alert').textContent).toContain('deleted on disk')
    expect(screen.queryByText('Reload')).toBeNull()
    fireEvent.click(screen.getByText('Recreate'))
    expect(onOverwrite).toHaveBeenCalledTimes(1)
  })
})
