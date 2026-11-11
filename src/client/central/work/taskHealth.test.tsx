/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FindingView } from '../../../shared/centralHealth'
import TaskBoard from './TaskBoard'
import { TL } from './taskBoardLabels'
import { card, makeClient, page } from './taskBoardFixtures.testutil'
import { TaskHealth, THL } from './taskHealth'

afterEach(cleanup)

const finding = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'f1', projectId: 'p1', fingerprint: 'fp', origin: 'review', rule: 'todo_no_context', severity: 'low', confidence: 'high',
  file: 'src/a.ts', line: 4, title: 'TODO without context', evidence: '// TODO later', source: 'Rule 17 (global CLAUDE.md)',
  suggestion: 'Add a scope and a tracking reference.', status: 'open', taskId: 't', dismissedReason: null, dismissedBy: null,
  firstSeenAt: 1, lastSeenAt: 1, fixedAt: null, ...over,
})

describe('TaskHealth', () => {
  it('shows loading, then each finding with severity, location, evidence, source and suggestion', async () => {
    let resolve!: (v: { items: FindingView[]; hasMore: boolean }) => void
    const listTaskFindings = vi.fn(() => new Promise<{ items: FindingView[]; hasMore: boolean }>((r) => { resolve = r }))
    render(<TaskHealth client={makeClient({}, { listTaskFindings })} taskId="t" refreshTick={0} />)
    expect(screen.getByRole('status').textContent).toBe(THL.loading)
    resolve({ items: [finding(), finding({ id: 'f2', rule: 'new_file_no_test', severity: 'medium', file: 'src/n.ts', line: null, title: 'New file has no test', status: 'dismissed' })], hasMore: true })
    const list = await screen.findByRole('list', { name: THL.heading })
    const rows = within(list).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows[0]).toContain('Low')
    expect(rows[0]).toContain('src/a.ts:4')
    expect(rows[0]).toContain('// TODO later')
    expect(rows[0]).toContain('Rule 17 (global CLAUDE.md)')
    expect(rows[0]).toContain(THL.suggestion('Add a scope and a tracking reference.'))
    expect(rows[1]).toContain('Medium')
    expect(rows[1]).toContain('src/n.ts')
    expect(rows[1]).toContain('Dismissed')
    expect(screen.getByText(THL.more)).toBeTruthy()
    expect(listTaskFindings).toHaveBeenCalledWith('t', expect.any(AbortSignal))
  })

  it('says so when the changed files had no issues', async () => {
    render(<TaskHealth client={makeClient({})} taskId="t" refreshTick={0} />)
    expect(await screen.findByText(THL.none)).toBeTruthy()
    expect(screen.queryByRole('list', { name: THL.heading })).toBeNull()
  })

  it('shows an error with a working retry', async () => {
    const listTaskFindings = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ items: [finding()], hasMore: false })
    render(<TaskHealth client={makeClient({}, { listTaskFindings })} taskId="t" refreshTick={0} />)
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: THL.retry }))
    expect(await screen.findByRole('list', { name: THL.heading })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(listTaskFindings).toHaveBeenCalledTimes(2)
  })
})

describe('task detail review checks', () => {
  const openDetail = async (status: 'needs_review' | 'running') => {
    const client = makeClient({ [status === 'running' ? 'in_progress' : 'needs_review']: page(card('a', status)) }, {
      getTask: vi.fn(async () => ({ task: card('a', status), assignments: [], timeline: [], hasMoreTimeline: false })),
      listTaskFindings: vi.fn(async () => ({ items: [finding()], hasMore: false })),
    })
    render(<TaskBoard client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: TL.showDetails('Task a') }))
    const aside = await screen.findByRole('complementary', { name: TL.detail })
    await within(aside).findByText('Objective a')
    return { aside, client }
  }

  it('appears on a task waiting for review', async () => {
    const { aside, client } = await openDetail('needs_review')
    expect(await within(aside).findByRole('list', { name: THL.heading })).toBeTruthy()
    expect(client.listTaskFindings.mock.calls[0]?.[0]).toBe('a')
  })

  it('is not shown before the task reaches review', async () => {
    const { aside, client } = await openDetail('running')
    expect(within(aside).queryByText(THL.heading)).toBeNull()
    expect(client.listTaskFindings).not.toHaveBeenCalled()
  })
})
