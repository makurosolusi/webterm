/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillLibrary from './SkillLibrary'
import { SkillCreateError, skillPost } from './skillCreateApi'

// Radix Checkbox/Switch measure themselves with ResizeObserver, which jsdom lacks.
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-mine', version: '1', sha256: null, status: 'active', origin: 'human', caps: ['portfolio.read'], createdAt: 1, proposedBy: 'human:root', approvedBy: 'human:root', approvedAt: 1, evalScore: null, enabled: true, ...over },
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

describe('edit as a new version', () => {
  it('prefills the form, shows a diff of the change, and saves through editSkill', async () => {
    const client = await open([row()])
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit skill' })
    expect((within(form).getByLabelText('Instructions (markdown)') as HTMLTextAreaElement).value).toBe('1. Read it.\n2. Ship it.')
    expect((within(form).getByLabelText('Name') as HTMLInputElement).disabled).toBe(true)
    const save = within(form).getByRole('button', { name: 'Save new version' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(within(form).getByText('No changes yet.')).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('Instructions (markdown)'), { target: { value: '1. Read it.\n2. Ship it twice.' } })
    const diff = within(form).getByLabelText('Changes from the current version')
    expect(diff.textContent).toContain('- 2. Ship it.')
    expect(diff.textContent).toContain('+ 2. Ship it twice.')
    fireEvent.click(save)
    await waitFor(() => expect(client.editSkill).toHaveBeenCalledWith('webterm-mine', { description: 'Deploy checklist.', body: '1. Read it.\n2. Ship it twice.', caps: ['portfolio.read'] }))
    expect(await screen.findByText('New version of webterm-mine saved. Review it below.')).toBeTruthy()
  })

  it('offers no Edit on a built-in skill and blocks Edit while a draft is open', async () => {
    await open([row({ origin: 'builtin' })])
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    cleanup()
    await open([row(), row({ version: '2', status: 'pending_approval' })])
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/already waiting for review/)).toBeTruthy()
  })
})

describe('duplicate a built-in skill', () => {
  it('forks through the client and says where the draft went', async () => {
    const client = await open([row({ origin: 'builtin', name: 'webterm-basics' })])
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate and edit' }))
    await waitFor(() => expect(client.forkSkill).toHaveBeenCalledWith('webterm-basics'))
    expect(await screen.findByText('Draft webterm-x-copy saved. Review it below.')).toBeTruthy()
  })
})

describe('approval variants', () => {
  const pending = (origin: SkillReviewRow['record']['origin']) => row({ name: `webterm-${origin}-d`, status: 'pending_approval', origin })

  it('a human draft shows the diff and one Approve button, no typed phrase', async () => {
    const client = fakeClient({ listSkills: vi.fn(async () => [pending('human')]) })
    render(<SkillLibrary client={client} />)
    expect(screen.queryByRole('textbox', { name: /Type/ })).toBeNull()
    const btn = await screen.findByRole('button', { name: 'Approve skill webterm-human-d 1' })
    expect(screen.getByLabelText('Diff')).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(client.approveSkillReviewed).toHaveBeenCalledWith('webterm-human-d', '1'))
    expect(client.approveSkill).not.toHaveBeenCalled()
  })

  it.each(['central', 'agent'] as const)('a %s draft keeps the typed phrase and its reason', async (origin) => {
    const client = fakeClient({ listSkills: vi.fn(async () => [pending(origin)]) })
    render(<SkillLibrary client={client} />)
    const btn = (await screen.findByRole('button', { name: `Approve skill webterm-${origin}-d 1` })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(new RegExp(`came from ${origin === 'agent' ? 'an agent' : 'Central'}`))).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: CONFIRM_PHRASE } })
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith(`webterm-${origin}-d`, '1', CONFIRM_PHRASE))
    expect(client.approveSkillReviewed).not.toHaveBeenCalled()
  })
})

describe('rejected drafts stay visible', () => {
  it('lists a human-rejected draft as rejected with a plain-language reason', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ status: 'rejected', rejectReason: 'rejected_by_human' })]) })} />)
    expect(await screen.findByText('Rejected: Rejected by you.')).toBeTruthy()
    expect(screen.getAllByText('rejected').length).toBeGreaterThan(0)
  })
})

describe('skillPost', () => {
  it('turns a non-JSON error body into the typed http_<status> error, never silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
    const err = await skillPost('/x', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SkillCreateError)
    expect(err).toMatchObject({ status: 502, code: 'http_502', issues: [] })
  })
})
