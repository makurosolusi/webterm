/** @vitest-environment jsdom */
// Slot Quick Open: Ctrl/Cmd+P hanya saat fokus di dalam node files, dikunci capabilities, Enter -> ctx.open.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ capabilities: vi.fn(), search: vi.fn() }))
vi.mock('./fsClient', () => fs)

import type { FilesSlotCtx } from './filesSlots'
import { quickOpenNode, resetSearchSlot, searchSlot } from './filesSlot.search'

const caps = (o: object) => ({ mutate: false, viewers: false, watch: false, git: false, quickOpen: true, upload: false, listMax: 1, ...o })
const mkCtx = (o: Partial<FilesSlotCtx> = {}): FilesSlotCtx => ({
  cwd: '/p', dir: '/p', entries: [], selection: [], refresh: vi.fn(), open: vi.fn(), startInput: vi.fn(), nodeId: 'n1', ...o,
})

/** Meniru FilesNode: useSlot tiap render, overlay di dalam elemen node ber-data-id, dan elemen lain di luar. */
function Host({ ctx }: { ctx: FilesSlotCtx }): ReactNode {
  searchSlot.useSlot?.(ctx)
  return (
    <>
      <div data-id={ctx.nodeId}><button type="button" data-testid="inside">in</button>{searchSlot.overlay?.(ctx)}</div>
      <div data-testid="outside" tabIndex={0} />
    </>
  )
}
const settle = () => act(async () => {})
const press = (el: Element, init: KeyboardEventInit) => {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'p', ...init })
  act(() => { el.dispatchEvent(ev) })
  return ev
}

beforeEach(() => {
  resetSearchSlot()
  fs.capabilities.mockResolvedValue(caps({}))
  fs.search.mockResolvedValue({ ok: true, files: ['src/a.ts', 'README.md'], truncated: false })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })

describe('Ctrl/Cmd+P', () => {
  it('opens Quick Open when focus is inside the node (Ctrl and Cmd) and swallows the browser shortcut', async () => {
    render(<Host ctx={mkCtx()} />)
    await settle()
    expect(press(screen.getByTestId('inside'), { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(quickOpenNode()).toBe('n1')
    expect(await screen.findByRole('combobox')).toBeTruthy()
    cleanup()
    resetSearchSlot()
    render(<Host ctx={mkCtx()} />)
    await settle()
    press(screen.getByTestId('inside'), { metaKey: true, key: 'P' })
    expect(quickOpenNode()).toBe('n1')
  })

  it('ignores the shortcut outside the node and other key combinations', async () => {
    render(<Host ctx={mkCtx()} />)
    await settle()
    expect(press(screen.getByTestId('outside'), { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press(document.body, { ctrlKey: true }).defaultPrevented).toBe(false)
    for (const init of [{}, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, key: 'o' }]) {
      expect(press(screen.getByTestId('inside'), init).defaultPrevented).toBe(false)
    }
    expect(quickOpenNode()).toBeNull()
  })

  it('flag off: no keyboard handler, nothing opens', async () => {
    fs.capabilities.mockResolvedValue(caps({ quickOpen: false }))
    render(<Host ctx={mkCtx()} />)
    await settle()
    expect(press(screen.getByTestId('inside'), { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(quickOpenNode()).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('capabilities throwing synchronously fails closed without crashing the node', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.capabilities.mockImplementation(() => { throw new Error('mock tanpa export') })
    render(<Host ctx={mkCtx()} />)
    await settle()
    expect(press(screen.getByTestId('inside'), { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(quickOpenNode()).toBeNull()
    expect(err).toHaveBeenCalled()
  })
})

describe('opening a result', () => {
  it('Enter calls ctx.open with the path relative to cwd, then closes', async () => {
    const ctx = mkCtx()
    render(<Host ctx={ctx} />)
    await settle()
    press(screen.getByTestId('inside'), { ctrlKey: true })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
    expect(fs.search).toHaveBeenCalledWith('/p', '*')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sa' } })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(ctx.open).toHaveBeenCalledWith({ name: 'src/a.ts', dir: false, ignored: false })
    expect(quickOpenNode()).toBeNull()
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
  })

  it('Escape closes without opening', async () => {
    const ctx = mkCtx()
    render(<Host ctx={ctx} />)
    await settle()
    press(screen.getByTestId('inside'), { ctrlKey: true })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(quickOpenNode()).toBeNull())
    expect(ctx.open).not.toHaveBeenCalled()
  })
})
