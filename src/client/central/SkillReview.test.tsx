/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillReview from './SkillReview'

afterEach(cleanup)

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-x', version: '1', sha256: null, status: 'pending_approval', origin: 'central', caps: [], createdAt: 1, proposedBy: 'c', approvedBy: null, approvedAt: null, evalScore: 1, ...over },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, ...extra,
})
const withRows = (...rows: SkillReviewRow[]) => fakeClient({ listSkills: vi.fn(async () => rows) })
const button = async (name: string) => (await screen.findByRole('button', { name })) as HTMLButtonElement

describe('SkillReview states', () => {
  it('shows the loading state, then empty', async () => {
    render(<SkillReview client={withRows()} />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(await screen.findByText('Nothing to show.')).toBeTruthy()
  })

  it('shows an error, and the off state for skills_off', async () => {
    const failing = fakeClient({ listSkills: vi.fn(async () => { throw new InboxApiError('boom', 500, 'internal_error') }) })
    const { unmount } = render(<SkillReview client={failing} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load')
    unmount()
    render(<SkillReview client={fakeClient({ listSkills: vi.fn(async () => { throw new InboxApiError('off', 503, 'skills_off') }) })} />)
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('SkillReview actions', () => {
  it('sends the typed phrase with approve', async () => {
    const client = withRows(row())
    render(<SkillReview client={client} />)
    const approve = await button('Approve skill webterm-x 1')
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type APPROVE/), { target: { value: CONFIRM_PHRASE } })
    fireEvent.click(approve)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith('webterm-x', '1', CONFIRM_PHRASE))
  })

  it('rejects an open row in one click, no phrase', async () => {
    const client = withRows(row({ status: 'proposed' }))
    render(<SkillReview client={client} />)
    fireEvent.click(await button('Reject webterm-x 1'))
    await waitFor(() => expect(client.rejectSkill).toHaveBeenCalledWith('webterm-x', '1'))
    expect(screen.queryByLabelText(/Type APPROVE/)).toBeNull()
  })

  it('a double click is one action and only that row is busy', async () => {
    let finish = () => {}
    const client = withRows(row(), row({ name: 'webterm-y' }))
    client.rejectSkill = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<SkillReview client={client} />)
    const reject = await button('Reject webterm-x 1')
    fireEvent.click(reject)
    fireEvent.click(reject)
    expect(client.rejectSkill).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(reject.disabled).toBe(true))
    expect((await button('Reject webterm-y 1')).disabled).toBe(false)
    finish()
    await waitFor(() => expect(client.listSkills).toHaveBeenCalledTimes(2))
  })

  it('a failed action shows the error and frees the row for a retry', async () => {
    const client = withRows(row())
    client.rejectSkill = vi.fn(async () => { throw new InboxApiError('nope', 409, 'limit') })
    render(<SkillReview client={client} />)
    const reject = await button('Reject webterm-x 1')
    fireEvent.click(reject)
    expect((await screen.findByRole('alert')).textContent).toContain('did not go through')
    expect(reject.disabled).toBe(false)
  })

  it('offers rollback only when the server says one is possible, and no reject on active rows', async () => {
    const client = withRows(row({ status: 'active' }, { canRollback: true }), row({ status: 'active', name: 'webterm-b', origin: 'builtin' }))
    render(<SkillReview client={client} />)
    fireEvent.click(await button('Rollback webterm-x 1'))
    await waitFor(() => expect(client.rollbackSkill).toHaveBeenCalledWith('webterm-x'))
    expect(screen.queryByRole('button', { name: 'Rollback webterm-b 1' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull()
  })

  it('shows why a proposal was rejected, without actions', async () => {
    render(<SkillReview client={withRows(row({ status: 'rejected', rejectReason: 'evaluation did not pass (score 0.2)' }))} />)
    expect(await screen.findByText('Rejected: evaluation did not pass (score 0.2)')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
