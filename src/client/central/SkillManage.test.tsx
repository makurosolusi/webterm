/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillLibrary from './SkillLibrary'

// Radix Checkbox/Switch measure themselves with ResizeObserver, which jsdom lacks.
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-mine', version: '1', sha256: null, status: 'active', origin: 'human', caps: ['portfolio.read'], createdAt: 1, proposedBy: 'human:root', approvedBy: 'human:root', approvedAt: 1, evalScore: null, enabled: true, audience: 'central' as const, ...over },
  lint: { ok: true, findings: [] }, diff: '+ a line', canRollback: false, description: 'Deploy checklist.', body: '1. Read it.\n2. Ship it.', ...extra,
})
const open = async (rows: SkillReviewRow[], over = {}) => {
  const client = fakeClient({ listSkills: vi.fn(async () => rows), ...over })
  render(<SkillLibrary client={client} />)
  fireEvent.click(await screen.findByRole('button', { name: `View ${rows[0].record.name} ${rows[0].record.version}` }))
  return client
}

describe('enable switch', () => {
  it('flips the skill off, shows the off state, and reloads the list', async () => {
    const client = await open([row()])
    const sw = screen.getByRole('switch', { name: 'Enabled' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => expect(client.setSkillEnabled).toHaveBeenCalledWith('webterm-mine', false))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByText(/Off: Central cannot see or load/)).toBeTruthy()
    expect(client.listSkills).toHaveBeenCalledTimes(2)
  })

  it('shows a disabled skill as off and keeps the switch on a failed change', async () => {
    const setSkillEnabled = vi.fn(async () => { throw new Error('boom') })
    await open([row({ enabled: false })], { setSkillEnabled })
    const sw = screen.getByRole('switch', { name: 'Enabled' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getAllByText('off').length).toBeGreaterThan(0)
    fireEvent.click(sw)
    expect((await screen.findAllByText(/The switch was not changed/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('revising goes through the agent', () => {
  it('offers Ask the agent to revise on a user skill and blocks it while a draft is open', async () => {
    await open([row()])
    expect((screen.getByRole('button', { name: 'Ask the agent to revise webterm-mine' }) as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    await open([row(), row({ version: '2', status: 'pending_approval' })])
    expect((screen.getByRole('button', { name: 'Ask the agent to revise webterm-mine' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/already waiting for review/)).toBeTruthy()
  })

  it('a built-in has no revise button, only a variant, and nothing offers to edit or duplicate it', async () => {
    await open([row({ origin: 'builtin', name: 'webterm-basics' })])
    expect(screen.queryByRole('button', { name: /Ask the agent to revise/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ask the agent for a variant webterm-basics' })).toBeTruthy()
    for (const name of [/^Edit/, /Duplicate/]) expect(screen.queryByRole('button', { name })).toBeNull()
  })
})

describe('approval needs the typed phrase for every draft', () => {
  const pending = (origin: SkillReviewRow['record']['origin']) => row({ name: `webterm-${origin}-d`, status: 'pending_approval', origin })

  it.each(['central', 'agent', 'human'] as const)('a %s draft shows the diff and keeps the typed phrase', async (origin) => {
    const client = fakeClient({ listSkills: vi.fn(async () => [pending(origin)]) })
    render(<SkillLibrary client={client} />)
    const btn = (await screen.findByRole('button', { name: `Approve skill webterm-${origin}-d 1` })) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(screen.getByLabelText('Diff')).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith(`webterm-${origin}-d`, '1'))
  })
})

describe('rejected drafts stay visible', () => {
  it('lists a human-rejected draft as rejected with a plain-language reason', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ status: 'rejected', rejectReason: 'rejected_by_human' })]) })} />)
    expect(await screen.findByText('Rejected: Rejected by you.')).toBeTruthy()
    expect(screen.getAllByText('rejected').length).toBeGreaterThan(0)
  })
})
