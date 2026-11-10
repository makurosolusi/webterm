/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../../inboxTypes'
import TaskBoard from './TaskBoard'
import { TL } from './taskBoardLabels'
import { TASK_BOARD_REFRESH_MS, type ColumnState } from './taskBoardModel'
import { setTaskBoardOpen, useTaskBoardView } from './taskBoardView'
import { backgroundRefresh, card, makeClient, named, page, pickProject, shimRadixSelect } from './taskBoardFixtures.testutil'

beforeAll(shimRadixSelect)
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('task board settings and states', () => {
  it('shows the auto-done switch only with a project selected, and saves it', async () => {
    const client = makeClient({ todo: page(card('a', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    expect(screen.queryByRole('switch', { name: TL.autoDone })).toBeNull()
    await pickProject('Alpha')
    const toggle = await screen.findByRole('switch', { name: TL.autoDone })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(client.setAutoDone).toHaveBeenCalledWith('p1', true))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })

  it('shows loading, then the empty sentence', async () => {
    render(<TaskBoard client={makeClient({})} />)
    expect(screen.getByRole('status').textContent).toBe(TL.loading)
    expect(await screen.findByText(TL.empty)).toBeTruthy()
  })

  it('shows an error with Retry that reloads', async () => {
    const listColumn = vi.fn().mockRejectedValue(new InboxApiError('GET failed', 500, 'boom'))
    const client = makeClient({}, { listColumn })
    render(<TaskBoard client={client} />)
    expect((await screen.findByRole('alert')).textContent).toContain(TL.loadFailed)
    listColumn.mockResolvedValue(page())
    fireEvent.click(screen.getByRole('button', { name: TL.retry }))
    expect(await screen.findByText(TL.empty)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the off state when the server says Central is off', async () => {
    render(<TaskBoard client={makeClient({}, { listColumn: vi.fn().mockRejectedValue(new InboxApiError('off', 503, 'central_off')) })} />)
    expect(await screen.findByText(TL.off)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the tab exists only while Central is on', () => {
    act(() => setTaskBoardOpen(true))
    expect(renderHook(() => useTaskBoardView(false)).result.current.open).toBe(false)
    expect(renderHook(() => useTaskBoardView(true)).result.current.open).toBe(true)
    act(() => setTaskBoardOpen(false))
  })
})

describe('task board refresh policy', () => {
  it('keeps an open note box and shows no loading state during a background refresh', async () => {
    const client = makeClient({ needs_review: page(card('r', 'needs_review')) })
    render(<TaskBoard client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: named(TL.requestChanges, 'Task r') }))
    const box = screen.getByRole('textbox', { name: named(TL.changesNote, 'Task r') }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'half written' } })

    const pending: Array<(p: ColumnState) => void> = []
    client.listColumn.mockClear()
    client.listColumn.mockImplementation(() => new Promise<ColumnState>((resolve) => { pending.push(resolve) }))
    backgroundRefresh()
    await waitFor(() => expect(pending).toHaveLength(4))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(TL.loading)).toBeNull()
    expect(screen.getByRole('textbox', { name: named(TL.changesNote, 'Task r') })).toBe(box)

    await act(async () => { pending.forEach((resolve) => resolve(page(card('r', 'needs_review', { updatedAt: 9 })))) })
    expect(screen.getByRole('textbox', { name: named(TL.changesNote, 'Task r') })).toBe(box)
    expect(box.value).toBe('half written')
  })

  it('a failed background refresh keeps the board and says so', async () => {
    const client = makeClient({ todo: page(card('a', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    client.listColumn.mockRejectedValue(new InboxApiError('GET failed', 500, 'boom'))
    backgroundRefresh()
    expect((await screen.findByRole('alert')).textContent).toContain(TL.loadFailed)
    expect(screen.getByText('Task a')).toBeTruthy()
  })

  it('refreshes every interval while shown, and not at all while hidden', async () => {
    vi.useFakeTimers()
    const client = makeClient({})
    const view = render(<TaskBoard client={client} visible={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_BOARD_REFRESH_MS * 2) })
    expect(client.listColumn).not.toHaveBeenCalled()
    view.rerender(<TaskBoard client={client} visible />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(client.listColumn).toHaveBeenCalledTimes(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_BOARD_REFRESH_MS) })
    expect(client.listColumn).toHaveBeenCalledTimes(8)
  })

  it('does not poll while the browser tab is in the background', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const client = makeClient({})
    render(<TaskBoard client={client} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    client.listColumn.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_BOARD_REFRESH_MS) })
    expect(client.listColumn).not.toHaveBeenCalled()
    hidden.mockRestore()
  })

  it('aborts in-flight reads on unmount', async () => {
    const signals: AbortSignal[] = []
    const client = makeClient({}, { listColumn: vi.fn((_c, _p, _r, signal?: AbortSignal) => { signals.push(signal!); return new Promise<ColumnState>(() => undefined) }) })
    const view = render(<TaskBoard client={client} />)
    await waitFor(() => expect(signals).toHaveLength(4))
    view.unmount()
    expect(signals.every((s) => s.aborted)).toBe(true)
  })
})
