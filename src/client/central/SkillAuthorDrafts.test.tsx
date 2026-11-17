/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { notifySkillAuthorActivity } from '../agentChat/skillAuthor.events'
import { NodeActionsProvider } from '../nodeActions'
import { InboxApiError } from '../inboxTypes'
import { SKILLS_OFF } from './centralControlApi'
import type { SkillReviewRow } from './centralControlTypes'
import { fakeClient } from './centralFixtures.testutil'
import SkillAuthorDrafts from './SkillAuthorDrafts'
import SkillLibrary from './SkillLibrary'
import { draftsOf } from './skillAuthorModel'

beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(cleanup)

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-mine', version: '2', sha256: null, status: 'pending_approval', origin: 'agent', caps: [], createdAt: 1, proposedBy: 'agent:n1', approvedBy: null, approvedAt: null, evalScore: null, enabled: true, ...over },
  lint: { ok: true, findings: [] }, diff: '+ new step', canRollback: false, description: 'Deploy.', body: '1. Ship.', ...extra,
})
const mine = row()
const others = [row({ version: '3', proposedBy: 'agent:other', name: 'webterm-theirs' }), row({ name: 'webterm-central', proposedBy: 'central:c1', origin: 'central' }), row({ name: 'webterm-old', status: 'rejected' }), row({ name: 'webterm-live', status: 'active' })]
const panel = (rows: SkillReviewRow[], over = {}) => {
  const client = fakeClient({ listSkills: vi.fn(async () => rows), ...over })
  const onChanged = vi.fn()
  render(<SkillAuthorDrafts nodeId="n1" client={client} onClose={() => {}} onChanged={onChanged} />)
  return { client, onChanged }
}

describe('draftsOf', () => {
  it('keeps only open drafts proposed by this chat node', () => {
    expect(draftsOf([mine, ...others], 'n1')).toEqual([mine])
  })
})

describe('drafts panel states', () => {
  it('shows the empty line when this agent proposed nothing, ignoring other proposers', async () => {
    panel(others)
    expect(await screen.findByText('The agent has not proposed anything yet')).toBeTruthy()
    expect(screen.queryByText('webterm-theirs')).toBeNull()
  })
  it('shows loading, then the draft with its diff against the active version', async () => {
    panel([mine, ...others])
    expect(screen.getByRole('status').textContent).toMatch(/Loading/)
    expect(await screen.findByText('webterm-mine')).toBeTruthy()
    expect(screen.getByLabelText('Diff').textContent).toContain('+ new step')
    expect(screen.queryByText('webterm-theirs')).toBeNull()
  })
  it('shows an error with Retry that loads again', async () => {
    const listSkills = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([mine])
    panel([], { listSkills })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('webterm-mine')).toBeTruthy()
    expect(listSkills).toHaveBeenCalledTimes(2)
  })
  it('says skills are off', async () => {
    panel([], { listSkills: vi.fn(async () => { throw new InboxApiError('off', 503, SKILLS_OFF) }) })
    expect(await screen.findByText(/Central skills are off/)).toBeTruthy()
  })
  it('refreshes on the Refresh button and when the chat reports activity (only its own node)', async () => {
    const { client } = panel([])
    await screen.findByText('The agent has not proposed anything yet')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(client.listSkills).toHaveBeenCalledTimes(2))
    act(() => notifySkillAuthorActivity('someone-else'))
    act(() => notifySkillAuthorActivity('n1'))
    await waitFor(() => expect(client.listSkills).toHaveBeenCalledTimes(3))
  })
})

describe('drafts panel actions', () => {
  it('an agent draft needs the typed phrase to approve', async () => {
    const { client, onChanged } = panel([mine])
    const approve = await screen.findByRole('button', { name: 'Approve skill webterm-mine 2' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: CONFIRM_PHRASE } })
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith('webterm-mine', '2', CONFIRM_PHRASE))
    expect(client.approveSkillReviewed).not.toHaveBeenCalled()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
  it('rejects a draft', async () => {
    const { client } = panel([mine])
    fireEvent.click(await screen.findByRole('button', { name: 'Reject webterm-mine 2' }))
    await waitFor(() => expect(client.rejectSkill).toHaveBeenCalledWith('webterm-mine', '2'))
  })
  it('Edit saves a new version after rejecting the agent draft once, even when the save is retried', async () => {
    const editSkill = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined)
    const { client } = panel([mine], { editSkill })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit webterm-mine 2' }))
    fireEvent.change(screen.getByLabelText('Instructions (markdown)'), { target: { value: '1. Ship it well.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }))
    await waitFor(() => expect(editSkill).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Save new version' }))
    await waitFor(() => expect(editSkill).toHaveBeenCalledTimes(2))
    expect(editSkill).toHaveBeenLastCalledWith('webterm-mine', expect.objectContaining({ body: '1. Ship it well.' }))
    expect(client.rejectSkill).toHaveBeenCalledTimes(1)
  })
  it('a human-origin version is approved with one click (no phrase)', async () => {
    const human = row({ origin: 'human', proposedBy: 'agent:n1' })
    const { client } = panel([human])
    fireEvent.click(await screen.findByRole('button', { name: 'Approve skill webterm-mine 2' }))
    await waitFor(() => expect(client.approveSkillReviewed).toHaveBeenCalledWith('webterm-mine', '2'))
  })
})

describe('Write with an agent buttons', () => {
  const active = row({ status: 'active', origin: 'human', proposedBy: 'human:root', version: '1' })
  const lib = (rows: SkillReviewRow[], openSkillAuthor?: (t?: string) => string) => render(
    <NodeActionsProvider value={{ onSession: () => {}, onToggleHideLinks: () => {}, openSkillAuthor }}>
      <SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => rows) })} />
    </NodeActionsProvider>,
  )
  it('library: opens a new-skill author node and shows its drafts panel', async () => {
    const open = vi.fn((_t?: string) => 'n1')
    lib([active, mine], open)
    fireEvent.click(await screen.findByRole('button', { name: 'Write with an agent' }))
    expect(open).toHaveBeenCalledWith()
    expect(await screen.findByLabelText('Drafts from this agent')).toBeTruthy()
  })
  it('detail: edits this skill with the skill name; builtin is disabled with the duplicate hint', async () => {
    const open = vi.fn((_t?: string) => 'n1')
    lib([active], open)
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-mine 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit with an agent' }))
    expect(open).toHaveBeenCalledWith('webterm-mine')
    cleanup()
    lib([row({ status: 'active', origin: 'builtin', proposedBy: null, name: 'webterm-core' })], open)
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-core 2' }))
    expect((screen.getByRole('button', { name: 'Edit with an agent' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Use Duplicate and edit first/)).toBeTruthy()
  })
  it('hides the buttons when Claude is disabled (no opener)', async () => {
    lib([active])
    await screen.findByText('webterm-mine')
    expect(screen.queryByRole('button', { name: 'Write with an agent' })).toBeNull()
  })
})
