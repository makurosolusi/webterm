/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../../inboxTypes'
import { focusCanvasNode } from '../../osNotify'
import TaskBoard from './TaskBoard'
import { taskBoardApi } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { assignment, card, makeClient, named, page } from './taskBoardFixtures.testutil'

vi.mock('../../osNotify', () => ({ focusCanvasNode: vi.fn() }))

beforeEach(() => { localStorage.clear(); vi.mocked(focusCanvasNode).mockClear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('task board card', () => {
  it('shows name, project, age, last signal and the badges of its state', async () => {
    const cards = [
      card('w', 'waiting_input', { assignment: assignment(), nodeName: 'Builder', nodeExists: true }),
      card('s', 'stalled', { lastRule: 'stalled', assignment: assignment() }),
      card('u', 'stalled', { lastRule: 'mystery_rule', assignment: assignment() }),
    ]
    render(<TaskBoard client={makeClient({ in_progress: page(...cards), todo: page(card('b', 'blocked', { blockedBy: [{ id: 'x', title: 'Set up auth' }] })), needs_review: page(card('v', 'verifying'), card('p', 'needs_review', { verification: { passed: true } }), card('f', 'failed', { verification: { passed: false } })) })} />)
    await screen.findByText('Task w')
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0)
    expect(screen.getByText('Builder')).toBeTruthy()
    expect(screen.getAllByText(/Active 2m ago/).length).toBeGreaterThan(0)
    expect(screen.getByText(TL.needsYou)).toBeTruthy()
    expect(screen.getByText(`${TL.stalled} · ${TL.rules.stalled}`)).toBeTruthy()
    expect(screen.getByText(`${TL.stalled} · mystery_rule`)).toBeTruthy()
    expect(screen.getByText(TL.blockedBy('Set up auth'))).toBeTruthy()
    expect(screen.getByText(TL.verifying)).toBeTruthy()
    expect(screen.getByText(TL.checksPassed)).toBeTruthy()
    expect(screen.getByText(TL.checksFailed)).toBeTruthy()
    expect(screen.getByText(TL.failed)).toBeTruthy()
  })

  it('Open node focuses the node, and is disabled with a reason when it is gone', async () => {
    render(<TaskBoard client={makeClient({ in_progress: page(card('a', 'running', { assignment: assignment(), nodeName: 'One', nodeExists: true }), card('b', 'running', { assignment: assignment({ nodeId: 'gone' }), nodeName: 'Two', nodeExists: false })) })} />)
    await screen.findByText('Task a')
    fireEvent.click(screen.getByRole('button', { name: named(TL.openNode, 'Task a') }))
    expect(focusCanvasNode).toHaveBeenCalledWith('node-1')
    expect((screen.getByRole('button', { name: named(TL.openNode, 'Task b') }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(TL.nodeGone)).toBeTruthy()
  })

  it('offers only the actions legal for each status', async () => {
    render(<TaskBoard client={makeClient({ todo: page(card('t', 'todo')), needs_review: page(card('r', 'needs_review'), card('f', 'failed')), done: page(card('d', 'done')) })} />)
    await screen.findByText('Task t')
    fireEvent.click(screen.getByRole('button', { name: TL.expandColumn(TL.columns.done) }))
    const has = (action: string, title: string): boolean => screen.queryByRole('button', { name: named(action, title) }) !== null
    expect([has(TL.approve, 'Task r'), has(TL.requestChanges, 'Task r'), has(TL.cancel, 'Task r'), has(TL.retryTask, 'Task r')]).toEqual([true, true, true, false])
    expect([has(TL.approve, 'Task f'), has(TL.retryTask, 'Task f'), has(TL.cancel, 'Task f')]).toEqual([false, true, true])
    expect([has(TL.approve, 'Task t'), has(TL.retryTask, 'Task t'), has(TL.cancel, 'Task t')]).toEqual([false, false, true])
    expect([has(TL.approve, 'Task d'), has(TL.retryTask, 'Task d'), has(TL.cancel, 'Task d')]).toEqual([false, false, false])
  })

  it('approve, changes, cancel and retry send the matching action and reload', async () => {
    const client = makeClient({ needs_review: page(card('r', 'needs_review'), card('f', 'failed')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task r')
    const reloads = (): number => client.listColumn.mock.calls.length
    const before = reloads()
    fireEvent.click(screen.getByRole('button', { name: named(TL.approve, 'Task r') }))
    await waitFor(() => expect(client.act).toHaveBeenLastCalledWith('r', 'approve', undefined))
    await waitFor(() => expect(reloads()).toBeGreaterThan(before))
    fireEvent.click(screen.getByRole('button', { name: named(TL.requestChanges, 'Task r') }))
    fireEvent.change(screen.getByRole('textbox', { name: named(TL.changesNote, 'Task r') }), { target: { value: ' add tests ' } })
    fireEvent.click(screen.getByRole('button', { name: named(TL.sendChanges, 'Task r') }))
    await waitFor(() => expect(client.act).toHaveBeenLastCalledWith('r', 'changes', { note: 'add tests' }))
    fireEvent.click(await screen.findByRole('button', { name: named(TL.cancel, 'Task f') }))
    expect(client.act).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: named(TL.cancelYes, 'Task f') }))
    await waitFor(() => expect(client.act).toHaveBeenLastCalledWith('f', 'cancel', undefined))
    fireEvent.click(await screen.findByRole('button', { name: named(TL.retryTask, 'Task f') }))
    await waitFor(() => expect(client.act).toHaveBeenLastCalledWith('f', 'retry', undefined))
  })

  it('a double click acts once', async () => {
    let finish: () => void = () => undefined
    const client = makeClient({ needs_review: page(card('r', 'needs_review')) }, { act: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })) })
    render(<TaskBoard client={client} />)
    const approve = await screen.findByRole('button', { name: named(TL.approve, 'Task r') })
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(client.act).toHaveBeenCalledTimes(1)
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(true))
    await act(async () => { finish() })
  })

  it('a refused action shows readable text and the board reloads', async () => {
    const client = makeClient({ needs_review: page(card('r', 'needs_review'), card('q', 'needs_review')) }, {
      act: vi.fn().mockRejectedValueOnce(new InboxApiError('POST failed', 409, 'illegal_transition')).mockRejectedValueOnce(new InboxApiError('POST failed', 409, 'odd_code')),
    })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task r')
    const before = client.listColumn.mock.calls.length
    const approve = screen.getByRole('button', { name: named(TL.approve, 'Task r') })
    fireEvent.click(approve)
    expect(approve.getAttribute('aria-busy')).toBe('true')
    expect(await screen.findByText(TL.actionErrors.illegal_transition!)).toBeTruthy()
    // The failed line carries Retry (toast), which acts again.
    await waitFor(() => expect(approve.closest('article')?.querySelector('[data-action-result="failed"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    await waitFor(() => expect(client.listColumn.mock.calls.length).toBeGreaterThan(before))
    fireEvent.click(screen.getByRole('button', { name: named(TL.approve, 'Task q') }))
    expect(await screen.findByText(TL.actionRefused('odd_code'))).toBeTruthy()
  })

  it('the live client posts to the path of each action', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ task: {} })))
    vi.stubGlobal('fetch', fetchMock)
    for (const action of ['approve', 'changes', 'cancel', 'retry'] as const) await taskBoardApi.act('t 1', action, action === 'changes' ? { note: 'x' } : undefined)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['approve', 'changes', 'cancel', 'retry'].map((a) => `/api/central/tasks/t%201/${a}`))
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ note: 'x' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({})
  })

  it('the live client rejects a 200 reply that carries an error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'illegal_transition' }))))
    await expect(taskBoardApi.act('t', 'approve')).rejects.toMatchObject({ code: 'illegal_transition' })
  })
})
