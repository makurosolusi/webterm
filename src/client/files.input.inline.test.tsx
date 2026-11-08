/** @vitest-environment jsdom */
// useFilesInput + FilesInput on a tree row (`at`): rename in place with the stem selected, Escape
// cancels, blur commits only a changed valid name, create lands under the target folder.
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fs = vi.hoisted(() => ({ mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn() }))
vi.mock('./fsClient', () => fs)

import type { InputRequest } from './filesSlots'
import { useFilesInput, type InputAt } from './useFilesInput'

let api: { start: (r: InputRequest) => void; at: InputAt }
const pendingSel: { current: string | null } = { current: null }
function Host() {
  const h = useFilesInput({ cwd: '/proj', listRef: createRef(), pendingSel, refresh: vi.fn(), setNotice: vi.fn(), openFile: vi.fn() })
  api = h
  return <>{h.row}</>
}
const begin = (req: InputRequest) => { render(<Host />); act(() => api.start(req)) }
const box = () => screen.getByRole('textbox') as HTMLInputElement

afterEach(() => { cleanup(); Object.values(fs).forEach((m) => m.mockReset()) })

describe('inline rename on a row', () => {
  it('renders in place of the row, prefilled, extension not selected; Enter commits', () => {
    const onCommit = vi.fn()
    begin({ kind: 'rename', initial: 'app.test.ts', at: 'src/app.test.ts', onCommit })
    expect(api.at).toEqual({ rel: 'src/app.test.ts', replace: true })
    const i = box()
    expect(i.value).toBe('app.test.ts')
    expect([i.selectionStart, i.selectionEnd]).toEqual([0, 'app.test'.length])
    fireEvent.change(i, { target: { value: 'main.ts' } })
    fireEvent.keyDown(i, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('main.ts')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Escape cancels without committing', () => {
    const onCommit = vi.fn()
    begin({ kind: 'rename', initial: 'a.ts', at: 'a.ts', onCommit })
    fireEvent.change(box(), { target: { value: 'b.ts' } })
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(api.at).toBeNull()
  })

  it('blur commits a changed name, but not an unchanged or invalid one', () => {
    const onCommit = vi.fn()
    begin({ kind: 'rename', initial: 'a.ts', at: 'a.ts', onCommit })
    fireEvent.blur(box())
    expect(onCommit).not.toHaveBeenCalled()
    act(() => api.start({ kind: 'rename', initial: 'a.ts', at: 'a.ts', onCommit }))
    fireEvent.change(box(), { target: { value: 'x/y' } })
    expect(screen.getByRole('alert').textContent).toContain('slash')
    fireEvent.blur(box())
    expect(onCommit).not.toHaveBeenCalled()
    act(() => api.start({ kind: 'rename', initial: 'a.ts', at: 'a.ts', onCommit }))
    fireEvent.change(box(), { target: { value: 'c.ts' } })
    fireEvent.blur(box())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('c.ts')
  })
})

describe('inline create under a folder', () => {
  it('New File at a folder row creates inside that folder', async () => {
    fs.create.mockResolvedValue({ ok: true })
    begin({ kind: 'file', at: 'src/lib' })
    expect(api.at).toEqual({ rel: 'src/lib', replace: false })
    fireEvent.change(box(), { target: { value: 'n.ts' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await act(async () => {})
    expect(fs.create).toHaveBeenCalledWith('/proj/src/lib/n.ts')
    expect(pendingSel.current).toBe('src/lib/n.ts') // selected by its tree path after reload
  })

  it('without `at` the input sits at the top (at = null) and creates in cwd', async () => {
    fs.mkdirChecked.mockResolvedValue({ ok: true, created: true })
    begin({ kind: 'folder' })
    expect(api.at).toBeNull()
    fireEvent.change(box(), { target: { value: 'd' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await act(async () => {})
    expect(fs.mkdirChecked).toHaveBeenCalledWith('/proj/d')
    expect(pendingSel.current).toBe('d')
  })
})
