/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkEventView } from '../../../shared/centralWork'
import TaskBoard from './TaskBoard'
import { TL } from './taskBoardLabels'
import { assignment, card, event, makeClient, page } from './taskBoardFixtures.testutil'

afterEach(cleanup)

describe('task detail', () => {
  const detail = (timeline: WorkEventView[], hasMoreTimeline = false) => ({
    task: card('a', 'running', { objective: 'Make login work', verification: { passed: false, summary: 'tests red' }, assignment: assignment({ id: 'a2' }), nodeName: 'Builder' }),
    assignments: [
      assignment({ id: 'a1', attempt: 1, channel: 'chat', nodeId: 'old-node', endedAt: 2000, endReason: 'vanished', result: { summary: 'crashed early' } }),
      assignment({ id: 'a2', attempt: 2, channel: 'terminal' }),
    ],
    timeline, hasMoreTimeline,
  })

  it('opens from a card and tells the whole story in order', async () => {
    const client = makeClient({ in_progress: page(card('a', 'running')) }, {
      getTask: vi.fn(async () => detail([
        event(3, { actor: 'system:stalled', from: 'running', to: 'stalled', rule: 'stalled', reason: 'no signal for 20 minutes' }),
        event(1, { actor: 'human:ui', from: null, to: 'todo', kind: 'work.task.todo' }),
        event(2, { actor: 'central', from: null, to: null, kind: 'work.assignment.open', rule: 'unheard_of' }),
      ])),
    })
    render(<TaskBoard client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: TL.showDetails('Task a') }))
    const aside = await screen.findByRole('complementary', { name: TL.detail })
    await within(aside).findByText('Make login work')
    expect(within(aside).getByText('src/a')).toBeTruthy()
    expect(within(aside).getByText(TL.acceptanceKinds.review)).toBeTruthy()
    expect(within(aside).getByText(TL.attempt(1))).toBeTruthy()
    expect(within(aside).getByText(/Chat · old-node/)).toBeTruthy()
    expect(within(aside).getByText(/Terminal · Builder/)).toBeTruthy()
    expect(within(aside).getByText(TL.rules.vanished!)).toBeTruthy()
    expect(within(aside).getByText('crashed early')).toBeTruthy()
    expect(within(aside).getByText(`${TL.checksFailed}: tests red`)).toBeTruthy()
    const rows = within(within(aside).getByRole('list', { name: TL.history })).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows[0]).toContain(`${TL.actors.human} ${TL.createdAs(TL.statuses.todo)}`)
    expect(rows[1]).toContain(`${TL.actors.central} ${TL.eventKinds['work.assignment.open']}`)
    expect(rows[1]).toContain('unheard_of')
    expect(rows[2]).toContain(`${TL.actors.system} ${TL.statuses.running} → ${TL.statuses.stalled}`)
    expect(rows[2]).toContain(`${TL.rules.stalled} · no signal for 20 minutes`)
  })

  it('Load more adds older pages without repeating rows', async () => {
    const getTask = vi.fn().mockResolvedValueOnce(detail([event(1)], true)).mockResolvedValue(detail([event(1), event(2)], false))
    render(<TaskBoard client={makeClient({ in_progress: page(card('a', 'running')) }, { getTask })} />)
    fireEvent.click(await screen.findByRole('button', { name: TL.showDetails('Task a') }))
    const button = await screen.findByRole('button', { name: TL.loadMore })
    fireEvent.click(button)
    await waitFor(() => expect(within(screen.getByRole('list', { name: TL.history })).getAllByRole('listitem')).toHaveLength(2))
    expect(getTask.mock.calls[1]?.[1]).toMatchObject({ offset: 1 })
    expect(screen.queryByRole('button', { name: TL.loadMore })).toBeNull()
  })

  it('Escape closes the detail, and clicking the card body opens it', async () => {
    render(<TaskBoard client={makeClient({ in_progress: page(card('a', 'running')) })} />)
    fireEvent.click((await screen.findByText('Alpha')).closest('article')!)
    const aside = await screen.findByRole('complementary', { name: TL.detail })
    fireEvent.keyDown(aside, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: TL.detail })).toBeNull()
  })
})
