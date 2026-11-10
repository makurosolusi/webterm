/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskBoard, { TASK_BOARD_PROJECT_KEY } from './TaskBoard'
import { TL } from './taskBoardLabels'
import { backgroundRefresh, card, column, makeClient, page, pickProject, shimRadixSelect } from './taskBoardFixtures.testutil'

beforeAll(shimRadixSelect)
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('task board columns', () => {
  it('puts each card in the column the server named, Done folded until opened', async () => {
    render(<TaskBoard client={makeClient({ todo: page(card('a', 'todo')), in_progress: page(card('b', 'running')), needs_review: page(card('c', 'needs_review')), done: page(card('d', 'done')) })} />)
    await screen.findByText('Task a')
    expect(within(column('todo')).getByText('Task a')).toBeTruthy()
    expect(within(column('in_progress')).getByText('Task b')).toBeTruthy()
    expect(within(column('needs_review')).getByText('Task c')).toBeTruthy()
    expect(within(column('done')).queryByText('Task d')).toBeNull()
    expect(within(column('done')).getByLabelText(TL.columnCount('1', TL.columns.done))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: TL.expandColumn(TL.columns.done) }))
    expect(within(column('done')).getByText('Task d')).toBeTruthy()
  })

  it('reads one request per column, not per card', async () => {
    const client = makeClient({ todo: page(card('a', 'todo'), card('b', 'todo'), card('c', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    expect(client.listColumn).toHaveBeenCalledTimes(4)
  })

  it('project filter refetches every column for that project and is remembered', async () => {
    const client = makeClient({ todo: page(card('a', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    client.listColumn.mockClear()
    await pickProject('Beta')
    await waitFor(() => expect(client.listColumn).toHaveBeenCalledTimes(4))
    for (const call of client.listColumn.mock.calls) expect(call[1]).toBe('p2')
    expect(localStorage.getItem(TASK_BOARD_PROJECT_KEY)).toBe('p2')
  })

  it('starts on the remembered project, and falls back to all when it is gone', async () => {
    localStorage.setItem(TASK_BOARD_PROJECT_KEY, 'p2')
    const client = makeClient({})
    const view = render(<TaskBoard client={client} />)
    await waitFor(() => expect(client.listColumn.mock.calls[0]?.[1]).toBe('p2'))
    view.unmount()
    localStorage.setItem(TASK_BOARD_PROJECT_KEY, 'gone')
    const after = makeClient({})
    render(<TaskBoard client={after} />)
    await waitFor(() => expect(after.listColumn.mock.calls.at(-1)?.[1]).toBeUndefined())
    expect(localStorage.getItem(TASK_BOARD_PROJECT_KEY)).toBe('gone')
  })

  it('Load more appends to its own column with the right offset', async () => {
    const client = makeClient({ todo: { items: [card('a', 'todo')], hasMore: true }, in_progress: page(card('b', 'running')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    client.listColumn.mockClear()
    client.listColumn.mockResolvedValueOnce(page(card('a2', 'todo')))
    fireEvent.click(screen.getByRole('button', { name: `${TL.loadMore}: ${TL.columns.todo}` }))
    expect(await within(column('todo')).findByText('Task a2')).toBeTruthy()
    expect(within(column('todo')).getByText('Task a')).toBeTruthy()
    expect(client.listColumn).toHaveBeenCalledTimes(1)
    expect(client.listColumn.mock.calls[0]).toEqual(['todo', undefined, expect.objectContaining({ offset: 1 }), expect.anything()])
    expect(screen.queryByRole('button', { name: `${TL.loadMore}: ${TL.columns.todo}` })).toBeNull()
  })

  it('a background refresh re-reads every row already loaded, so Load more is not undone', async () => {
    const many = Array.from({ length: 60 }, (_, i) => card(`n${i}`, 'todo'))
    const client = makeClient({ todo: page(...many) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task n0')
    client.listColumn.mockClear()
    backgroundRefresh()
    await waitFor(() => expect(client.listColumn).toHaveBeenCalledTimes(4))
    expect(client.listColumn.mock.calls[0]?.[2]).toEqual({ limit: 60, offset: 0 })
  })
})
