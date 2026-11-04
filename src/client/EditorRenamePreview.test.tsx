/** @vitest-environment jsdom */
// Rename preview dialog: only the asking node shows it, it lists before/after per file, and
// Apply / Cancel resolve the pending rename.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import './vscode/test-setup'
import { EditorRenamePreview } from './EditorRenamePreview'
import { answerRenamePreview, requestRenamePreview } from './editorLsp.store'
import { act } from 'react'

const PREVIEW = { nodeId: 'n1', newName: 'total', files: [{ path: '/w/a.ts', lines: [{ line: 3, before: '  const sum = 1', after: '  const total = 1' }] }, { path: '/w/b.ts', lines: [{ line: 9, before: 'f(sum)', after: 'f(total)' }] }] }

afterEach(() => { cleanup(); answerRenamePreview(false) })

describe('EditorRenamePreview', () => {
  it('shows the edits in the asking node only; Apply resolves true', async () => {
    render(<><EditorRenamePreview nodeId="n1" /><EditorRenamePreview nodeId="n2" /></>)
    let answer!: Promise<boolean>
    act(() => { answer = requestRenamePreview(PREVIEW) })
    expect(screen.getAllByTestId('rename-preview')).toHaveLength(1)
    expect(screen.getByText('Rename to “total”')).toBeTruthy()
    expect(screen.getByText(/2 changes in 2 files/)).toBeTruthy()
    expect(screen.getByText('const sum = 1').tagName).toBe('DEL')
    expect(screen.getByText('f(total)').tagName).toBe('INS')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await answer).toBe(true)
    expect(screen.queryByTestId('rename-preview')).toBeNull()
  })

  it('Cancel resolves false', async () => {
    render(<EditorRenamePreview nodeId="n1" />)
    let answer!: Promise<boolean>
    act(() => { answer = requestRenamePreview(PREVIEW) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await answer).toBe(false)
  })
})
