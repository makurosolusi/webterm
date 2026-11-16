/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkOwner, WorkStatus } from '../../../shared/centralWork'
import { OPEN_STATUSES, ownerOf } from '../../../server/central/work/workOwner'
import TaskBoard from './TaskBoard'
import { TaskCard } from './TaskCard'
import { TL } from './taskBoardLabels'
import { assignment, card, makeClient, page } from './taskBoardFixtures.testutil'
import { leaseLabel, nextStep, ownerFacts, ownerLabel } from './taskOwnerModel'

vi.mock('../../osNotify', () => ({ focusCanvasNode: vi.fn() }))
afterEach(cleanup)

const NOW = 1_800_000_000_000
const MIN = 60_000

describe('owner model', () => {
  it('names the four owners', () => {
    const owners: WorkOwner[] = ['agent', 'central', 'verifier', 'human']
    expect(owners.map(ownerLabel)).toEqual(['Agent', 'Central', 'Verifier', 'You'])
  })

  it('has a next step for every open status and none for the rest', () => {
    const steps = Object.fromEntries(OPEN_STATUSES.map((s) => [s, nextStep({ status: s })]))
    expect(steps).toEqual({
      assigned: 'Agent is starting', running: 'Agent is working', stalled: 'Central is deciding what to do', waiting_input: 'Waiting for an answer',
      reported: 'Result is being checked', verifying: 'Verifier is checking', needs_review: 'Waiting for your review', failed: 'Central is handling the failure',
    })
    for (const s of ['todo', 'blocked', 'done', 'cancelled'] as WorkStatus[]) expect(nextStep({ status: s })).toBeNull()
  })

  it('POLICY: every open status the server owns has an owner label and a next step', () => {
    for (const status of OPEN_STATUSES) {
      const owner = ownerOf(status)
      expect(owner, status).not.toBeNull()
      expect(ownerLabel(owner!), status).toBeTruthy()
      expect(nextStep({ status }), `next step of ${status}`).toBeTruthy()
    }
  })

  it('words the lease as due, overdue or nothing', () => {
    expect(leaseLabel(NOW + 4 * MIN, NOW)).toBe('Due in 4m')
    expect(leaseLabel(NOW + 1, NOW)).toBe('Due in 1m')
    expect(leaseLabel(NOW - 2 * MIN, NOW)).toBe('Overdue 2m')
    expect(leaseLabel(NOW, NOW)).toBe('Overdue 1m')
    expect(leaseLabel(NOW + 90 * MIN, NOW)).toBe('Due in 1h')
    expect(leaseLabel(null, NOW)).toBeNull()
    expect(leaseLabel(undefined, NOW)).toBeNull()
  })

  it('shows facts only for an owned task', () => {
    expect(ownerFacts({ status: 'todo', owner: null, assignment: null }, NOW, false)).toMatchObject({ owner: null, step: null, lease: null, aria: null })
    expect(ownerFacts({ status: 'running', owner: undefined, assignment: null }, NOW, false).owner).toBeNull()
    const f = ownerFacts({ status: 'running', owner: 'agent', assignment: assignment({ leaseUntil: NOW - MIN }) }, NOW, false)
    expect(f).toMatchObject({ owner: 'agent', lease: 'Overdue 1m', overdue: true, paused: false, aria: 'Owner Agent. Next: Agent is working.' })
  })
})

describe('task detail owner facts', () => {
  it('lists owner, next step and lease from the same facts as the card', async () => {
    const task = card('a', 'running', { owner: 'agent', assignment: assignment({ leaseUntil: Date.now() + 3 * MIN - 5000 }) })
    const client = makeClient({ in_progress: page(task) }, { getTask: vi.fn(async () => ({ task, assignments: [task.assignment!], timeline: [], hasMoreTimeline: false })) })
    render(<TaskBoard client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: TL.showDetails('Task a') }))
    const aside = await screen.findByRole('complementary', { name: TL.detail })
    const dl = await within(aside).findByRole('group', { name: 'Owner Agent. Next: Agent is working.' })
    expect(dl.textContent).toBe('OwnerAgentNext stepAgent is workingLeaseDue in 3m')
  })
})

describe('task card owner line', () => {
  it('renders owner, next step and lease, with a spoken label', () => {
    const c = card('r', 'running', { owner: 'agent', assignment: assignment({ leaseUntil: Date.now() + 4 * MIN - 5000 }), nodeName: 'Builder', nodeExists: true })
    render(<TaskCard card={c} busy={false} refused={undefined} selected={false} onAct={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Owner Agent. Next: Agent is working.' }).textContent).toBe('Agent · Agent is working')
    expect(screen.getByText(/Due in 4m/)).toBeTruthy()
  })

  it('marks an overdue lease and names the human owner', () => {
    const c = card('n', 'needs_review', { owner: 'human', assignment: assignment({ leaseUntil: Date.now() - 2 * MIN - 5000, endedAt: 5 }) })
    render(<TaskCard card={c} busy={false} refused={undefined} selected={false} onAct={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Owner You. Next: Waiting for your review.' })).toBeTruthy()
    expect(screen.getByText(/Overdue 2m/).closest('[data-overdue]')?.getAttribute('data-overdue')).toBe('true')
  })

  it('shows no owner line on a task without an assignment or an owner', () => {
    render(<TaskCard card={card('t', 'todo', { owner: null })} busy={false} refused={undefined} selected={false} onAct={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByText(/Due in|Overdue/)).toBeNull()
  })

  it('shows an owner without a lease when the attempt has none', () => {
    const c = card('s', 'stalled', { owner: 'central', assignment: assignment({ leaseUntil: null }) })
    render(<TaskCard card={c} busy={false} refused={undefined} selected={false} onAct={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByRole('group', { name: /Owner Central/ })).toBeTruthy()
    expect(screen.queryByText(/Due in|Overdue/)).toBeNull()
    expect(TL.owners.central).toBe('Central')
  })
})
