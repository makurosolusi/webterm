/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalCard, ReminderCard, TaskCard as TaskCardData } from '../../../shared/centralWork'
import { InboxApiError } from '../../inboxTypes'
import { dueBadge, dueWords, legalGoalActions } from './planningModel'
import TaskBoard from './TaskBoard'
import { backgroundRefresh, card, column, makeClient, page, pickProject, shimRadixSelect } from './taskBoardFixtures.testutil'
import { TL } from './taskBoardLabels'
import { cardBadges } from './taskBoardModel'

// test-only fixtures
const goal = (over: Partial<GoalCard> = {}): GoalCard => ({
  projectId: 'p1', projectName: 'Alpha', version: 2, statement: 'Ship login', status: 'active', horizon: '2026-12-01',
  counts: { todo: 2, in_progress: 1, needs_review: 1, done: 3 }, total: 7, complete: false, ...over,
})
const goals = (...items: GoalCard[]) => ({ items, hasMore: false })
const reminder = (id: string, over: Partial<ReminderCard> = {}): ReminderCard => ({ id, projectId: 'p1', projectName: 'Alpha', taskId: null, text: `Reminder ${id}`, dueAt: Date.now() + 3 * 3_600_000, status: 'pending', ...over })
const MINUTE = 60_000
const NOW = 1_800_000_000_000
const stale = new InboxApiError('POST failed', 409, 'stale_version')

beforeAll(shimRadixSelect)
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('goals strip', () => {
  it('shows progress, counts and horizon for a goal', async () => {
    render(<TaskBoard client={makeClient({}, { listGoals: vi.fn(async () => goals(goal())) })} />)
    const strip = await screen.findByRole('region', { name: TL.goals })
    expect(within(strip).getByText('Ship login')).toBeTruthy()
    expect(within(strip).getByText('3 of 7 done')).toBeTruthy()
    expect(within(strip).getByText('Alpha')).toBeTruthy()
    expect(within(strip).getByText('By 2026-12-01')).toBeTruthy()
    expect(within(strip).getByText('Todo 2 · In progress 1 · Needs review 1 · Done 3')).toBeTruthy()
    const bar = within(strip).getByRole('progressbar', { name: TL.goalProgressOf('Ship login') }) as HTMLProgressElement
    expect([bar.value, bar.max]).toEqual([3, 7])
    expect(within(strip).queryByText(TL.goalAllDone)).toBeNull()
  })

  it('says all tasks are done only when the server calls the goal complete', async () => {
    render(<TaskBoard client={makeClient({}, { listGoals: vi.fn(async () => goals(goal({ complete: true, counts: { todo: 0, in_progress: 0, needs_review: 0, done: 2 }, total: 2 }))) })} />)
    expect(await screen.findByText(TL.goalAllDone)).toBeTruthy()
  })

  it('offers only the legal move for each status', async () => {
    expect(legalGoalActions('proposed')).toEqual(['activate'])
    expect(legalGoalActions('active')).toEqual(['abandon'])
    for (const s of ['achieved', 'abandoned', 'superseded'] as const) expect(legalGoalActions(s)).toEqual([])
    render(<TaskBoard client={makeClient({}, { listGoals: vi.fn(async () => goals(goal({ status: 'proposed', statement: 'P' }), goal({ version: 3, statement: 'A' }), goal({ version: 4, status: 'achieved', statement: 'Z' }))) })} />)
    await screen.findByText('P')
    expect(screen.getByRole('button', { name: TL.actionOn(TL.goalActivate, 'P') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: TL.actionOn(TL.goalAbandon, 'P') })).toBeNull()
    expect(screen.getByRole('button', { name: TL.actionOn(TL.goalAbandon, 'A') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: TL.actionOn(TL.goalActivate, 'A') })).toBeNull()
    expect(screen.queryByRole('button', { name: TL.actionOn(TL.goalActivate, 'Z') })).toBeNull()
    expect(screen.queryByRole('button', { name: TL.actionOn(TL.goalAbandon, 'Z') })).toBeNull()
  })

  it('a double click on Activate sends once and reloads goals and the board', async () => {
    let finish: () => void = () => undefined
    const client = makeClient({}, { listGoals: vi.fn(async () => goals(goal({ status: 'proposed' }))), activateGoal: vi.fn(() => new Promise<void>((r) => { finish = r })) })
    render(<TaskBoard client={client} />)
    const button = await screen.findByRole('button', { name: TL.actionOn(TL.goalActivate, 'Ship login') })
    client.listGoals.mockClear()
    client.listColumn.mockClear()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(client.activateGoal).toHaveBeenCalledTimes(1)
    expect(client.activateGoal).toHaveBeenCalledWith('p1', 2)
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
    finish()
    await waitFor(() => expect(client.listGoals).toHaveBeenCalled())
    await waitFor(() => expect(client.listColumn).toHaveBeenCalled())
  })

  it('in-flight state belongs to one row', async () => {
    const client = makeClient({}, { listGoals: vi.fn(async () => goals(goal({ status: 'proposed', statement: 'One' }), goal({ projectId: 'p2', status: 'proposed', statement: 'Two' }))), activateGoal: vi.fn(() => new Promise<void>(() => undefined)) })
    render(<TaskBoard client={client} />)
    const one = await screen.findByRole('button', { name: TL.actionOn(TL.goalActivate, 'One') }) as HTMLButtonElement
    fireEvent.click(one)
    await waitFor(() => expect(one.disabled).toBe(true))
    expect((screen.getByRole('button', { name: TL.actionOn(TL.goalActivate, 'Two') }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Abandon asks once before it sends', async () => {
    const client = makeClient({}, { listGoals: vi.fn(async () => goals(goal())) })
    render(<TaskBoard client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: TL.actionOn(TL.goalAbandon, 'Ship login') }))
    expect(client.abandonGoal).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('group', { name: TL.goalAbandonConfirm })).getByRole('button', { name: TL.cancelNo }))
    expect(screen.queryByRole('group', { name: TL.goalAbandonConfirm })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: TL.actionOn(TL.goalAbandon, 'Ship login') }))
    fireEvent.click(screen.getByRole('button', { name: TL.actionOn(TL.goalAbandonYes, 'Ship login') }))
    await waitFor(() => expect(client.abandonGoal).toHaveBeenCalledWith('p1', 2))
  })

  it('a stale version shows readable text and reloads', async () => {
    const client = makeClient({}, { listGoals: vi.fn(async () => goals(goal({ status: 'proposed' }))), activateGoal: vi.fn(async () => { throw stale }) })
    render(<TaskBoard client={client} />)
    const button = await screen.findByRole('button', { name: TL.actionOn(TL.goalActivate, 'Ship login') })
    client.listGoals.mockClear()
    fireEvent.click(button)
    expect((await screen.findByRole('alert')).textContent).toBe(TL.goalErrors.stale_version)
    await waitFor(() => expect(client.listGoals).toHaveBeenCalled())
  })

  it('is hidden entirely with no goals', async () => {
    const client = makeClient({ todo: page(card('a', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    await waitFor(() => expect(screen.queryByText(TL.goalsLoading)).toBeNull())
    expect(screen.queryByRole('region', { name: TL.goals })).toBeNull()
  })

  it('follows the project select', async () => {
    const client = makeClient({ todo: page(card('a', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    expect(client.listGoals.mock.calls[0]?.[0]).toBeUndefined()
    client.listGoals.mockClear()
    await pickProject('Beta')
    await waitFor(() => expect(client.listGoals.mock.calls.at(-1)?.[0]).toBe('p2'))
  })

  it('collapses, and a background refresh keeps the rows on screen', async () => {
    const client = makeClient({}, { listGoals: vi.fn(async () => goals(goal())) })
    render(<TaskBoard client={client} />)
    const row = await screen.findByText('Ship login')
    let settle: (v: ReturnType<typeof goals>) => void = () => undefined
    client.listGoals.mockReturnValueOnce(new Promise((r) => { settle = r }))
    backgroundRefresh()
    expect(screen.getByText('Ship login')).toBe(row)
    expect(screen.queryByText(TL.goalsLoading)).toBeNull()
    settle(goals(goal({ statement: 'Ship signup' })))
    expect(await screen.findByText('Ship signup')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: TL.collapseColumn(TL.goals) }))
    expect(screen.queryByText('Ship signup')).toBeNull()
  })

  it('a failed first load offers Retry', async () => {
    const client = makeClient({}, { listGoals: vi.fn(async () => { throw new InboxApiError('GET failed', 500, 'boom') }) })
    render(<TaskBoard client={client} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(TL.goalsFailed)
    client.listGoals.mockResolvedValue(goals(goal()))
    fireEvent.click(within(alert).getByRole('button', { name: TL.retry }))
    expect(await screen.findByText('Ship login')).toBeTruthy()
  })
})

describe('due badges', () => {
  it('words the time left at each boundary', () => {
    expect(dueWords(NOW - 1, NOW)).toBe(TL.overdue)
    expect(dueWords(NOW, NOW)).toBe(TL.overdue)
    expect(dueWords(NOW + 1, NOW)).toBe('Due in 1m')
    expect(dueWords(NOW + 59 * MINUTE, NOW)).toBe('Due in 59m')
    expect(dueWords(NOW + 60 * MINUTE, NOW)).toBe('Due in 1h')
    expect(dueWords(NOW + 180 * MINUTE, NOW)).toBe('Due in 3h')
    expect(dueWords(NOW + 23 * 60 * MINUTE, NOW)).toBe('Due in 23h')
    expect(dueWords(NOW + 24 * 60 * MINUTE, NOW)).toBe('Due in 1d')
  })

  it('is red once overdue, and absent without a date or on a finished task', () => {
    expect(dueBadge({ dueAt: NOW - 1, status: 'running' }, NOW)).toEqual({ text: TL.overdue, tone: 'error' })
    expect(dueBadge({ dueAt: NOW + MINUTE, status: 'todo' }, NOW)?.tone).toBe('info')
    expect(dueBadge({ dueAt: null, status: 'todo' }, NOW)).toBeNull()
    expect(dueBadge({ dueAt: NOW - 1, status: 'done' }, NOW)).toBeNull()
    expect(dueBadge({ dueAt: NOW - 1, status: 'cancelled' }, NOW)).toBeNull()
  })

  it('carries the goal marker on a card of a plan only', () => {
    const texts = (c: TaskCardData): string[] => cardBadges(c, NOW).map((b) => b.text)
    expect(texts(card('a', 'todo', { goalVersion: 3, dueAt: NOW + 180 * MINUTE }))).toEqual(['Due in 3h', TL.goalMarker(3)])
    expect(texts(card('b', 'todo', { goalVersion: null }))).toEqual([])
    expect(texts(card('c', 'todo'))).toEqual([])
  })

  it('renders an overdue badge on the card, with Todo in server order', async () => {
    const dueAt = Date.now() - MINUTE
    render(<TaskBoard client={makeClient({ todo: page(card('z', 'todo', { seq: 1, dueAt }), card('a', 'todo', { seq: 2 })) })} />)
    await screen.findByText('Task z')
    const titles = within(column('todo')).getAllByRole('button', { name: /^Show details/ }).map((b) => b.textContent)
    expect(titles).toEqual(['Task z', 'Task a'])
    expect(within(column('todo')).getByText(TL.overdue).getAttribute('data-tone')).toBe('error')
  })
})

describe('upcoming list', () => {
  const upcoming = () => screen.findByRole('region', { name: TL.upcoming })

  it('shows pending reminders with text, project and time', async () => {
    render(<TaskBoard client={makeClient({}, { listReminders: vi.fn(async () => ({ items: [reminder('r1')], hasMore: false })) })} />)
    const list = await upcoming()
    expect(within(list).getByText('Reminder r1')).toBeTruthy()
    expect(within(list).getByText('Alpha')).toBeTruthy()
    expect(within(list).getByText(/^Due in (3h|2h)$/)).toBeTruthy()
  })

  it('is hidden when empty', async () => {
    const client = makeClient({ todo: page(card('a', 'todo')) })
    render(<TaskBoard client={client} />)
    await screen.findByText('Task a')
    await waitFor(() => expect(screen.queryByText(TL.remindersLoading)).toBeNull())
    expect(screen.queryByRole('region', { name: TL.upcoming })).toBeNull()
  })

  it('Cancel sends once on a double click and the row goes away with the reload', async () => {
    let rows = [reminder('r1')]
    let finish: () => void = () => undefined
    const client = makeClient({}, { listReminders: vi.fn(async () => ({ items: rows, hasMore: false })), cancelReminder: vi.fn(() => new Promise<void>((r) => { finish = () => { rows = []; r() } })) })
    render(<TaskBoard client={client} />)
    const button = await screen.findByRole('button', { name: TL.actionOn(TL.cancel, 'Reminder r1') })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(client.cancelReminder).toHaveBeenCalledTimes(1)
    expect(client.cancelReminder).toHaveBeenCalledWith('r1')
    finish()
    await waitFor(() => expect(screen.queryByRole('region', { name: TL.upcoming })).toBeNull())
  })

  it('Load more appends with the right offset', async () => {
    const client = makeClient({}, { listReminders: vi.fn(async () => ({ items: [reminder('r1')], hasMore: true })) })
    render(<TaskBoard client={client} />)
    await upcoming()
    client.listReminders.mockResolvedValueOnce({ items: [reminder('r2')], hasMore: false })
    fireEvent.click(screen.getByRole('button', { name: `${TL.loadMore}: ${TL.upcoming}` }))
    expect(await screen.findByText('Reminder r2')).toBeTruthy()
    expect(client.listReminders.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ offset: 1 }))
  })
})
