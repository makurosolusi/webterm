/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillLibrary from './SkillLibrary'

// Radix Checkbox measures itself with ResizeObserver, which jsdom lacks.
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-x', version: '1', sha256: null, status: 'active', origin: 'builtin', caps: ['portfolio.read'], createdAt: 1, proposedBy: null, approvedBy: 'system:builtin', approvedAt: 1, evalScore: null, audience: 'central' as const, ...over },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, description: 'Summarize project status.', body: '1. Read the portfolio.', ...extra,
})
const withRows = (...rows: SkillReviewRow[]) => fakeClient({ listSkills: vi.fn(async () => rows) })

describe('SkillLibrary browse', () => {
  it('lists name, description, built-in badge and version (no badge for the normal state)', async () => {
    render(<SkillLibrary client={withRows(row())} />)
    const item = (await screen.findByText('Summarize project status.')).closest('li') as HTMLElement
    expect(within(item).getByText('webterm-x')).toBeTruthy()
    expect(within(item).getByText('Built-in')).toBeTruthy()
    expect(within(item).queryByText('active')).toBeNull()
    expect(within(item).queryByText('Central')).toBeNull()
    expect(within(item).getByText('v1')).toBeTruthy()
  })

  it('searches by name, description and origin', async () => {
    render(<SkillLibrary client={withRows(row(), row({ name: 'webterm-mine', origin: 'human', status: 'pending_approval' }, { description: 'Deploy checklist.' }))} />)
    const search = await screen.findByLabelText('Search skills')
    fireEvent.change(search, { target: { value: 'checklist' } })
    expect(screen.queryByRole('button', { name: 'View webterm-x 1' })).toBeNull()
    expect(screen.getByRole('button', { name: 'View webterm-mine 1' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'builtin' } })
    expect(screen.getByRole('button', { name: 'View webterm-x 1' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText(/No skills match “zzz”/)).toBeTruthy()
  })

  it('opens a read-only detail with the body; builtin says so', async () => {
    render(<SkillLibrary client={withRows(row())} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-x 1' }))
    const detail = screen.getByRole('article', { name: 'webterm-x 1 details' })
    expect(within(detail).getByLabelText('Instructions (markdown)').textContent).toBe('1. Read the portfolio.')
    expect(within(detail).getByText('Built-in, read only')).toBeTruthy()
    expect(within(detail).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(detail).getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('article', { name: 'webterm-x 1 details' })).toBeNull()
  })

  it('shows only rows that need a human in the review list', async () => {
    render(<SkillLibrary client={withRows(row(), row({ name: 'webterm-d', status: 'pending_approval', origin: 'human' }))} />)
    expect(await screen.findByRole('button', { name: 'Reject webterm-d 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reject webterm-x 1' })).toBeNull()
  })
})

describe('SkillLibrary states', () => {
  it('shows empty, and a loading line first', async () => {
    render(<SkillLibrary client={withRows()} />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(await screen.findByText(/^No skills yet\. Skills are written with the agent/)).toBeTruthy()
    expect(screen.queryByLabelText('Search skills')).toBeNull()
  })

  it('shows an error with a working retry', async () => {
    const listSkills = vi.fn().mockRejectedValueOnce(new InboxApiError('boom', 500, 'internal_error')).mockResolvedValue([row()])
    render(<SkillLibrary client={fakeClient({ listSkills })} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Summarize project status.')).toBeTruthy()
    expect(listSkills).toHaveBeenCalledTimes(2)
  })

  it('when skills are off it shows the reason and no Write with an agent button', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => { throw new InboxApiError('off', 503, 'skills_off') }) })} />)
    expect(await screen.findByText(/Central skills are off/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Write with an agent/ })).toBeNull()
  })
})

describe('SkillLibrary has no manual authoring', () => {
  const mount = async (client = withRows(row({ origin: 'central', status: 'active' }))) => {
    render(<SkillLibrary client={client} chat={{ createConversation: vi.fn(async () => ({}) as never) }} />)
    await screen.findAllByText('Summarize project status.')
  }

  it('has no New skill button, no form, no text field for a skill, no Edit or Duplicate anywhere', async () => {
    await mount(withRows(row({ origin: 'central' }), row({ name: 'webterm-d', status: 'pending_approval', origin: 'agent' }), row({ name: 'webterm-b', origin: 'builtin' })))
    for (const name of [/New skill/, /^Edit/, /Duplicate/, /Create draft/, /Save new version/]) expect(screen.queryByRole('button', { name })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View webterm-x 1' }))
    for (const name of [/New skill/, /^Edit/, /Duplicate/]) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.queryByLabelText('When to use')).toBeNull()
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('offers Write with an agent in each section', async () => {
    await mount()
    expect(screen.getByRole('button', { name: 'Write with an agent (Central)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Write with an agent (Canvas)' })).toBeTruthy()
  })

  it('shows the title first (the name when a skill has none) and no kind badge', async () => {
    render(<SkillLibrary client={withRows(row({ name: 'webterm-titled', title: 'Weekly status report', origin: 'central' }), row({ name: 'webterm-legacy', origin: 'central' }))} />)
    const titled = (await screen.findByRole('button', { name: 'View webterm-titled 1' })).closest('li') as HTMLElement
    expect(within(titled).getByText('Weekly status report')).toBeTruthy()
    expect(within(titled).getByText('webterm-titled')).toBeTruthy()
    expect(within(titled).queryByText('Central')).toBeNull()
    const legacy = screen.getByRole('button', { name: 'View webterm-legacy 1' }).closest('li') as HTMLElement
    expect(within(legacy).getAllByText('webterm-legacy')).toHaveLength(1)
  })

  it('a user skill detail offers Ask the agent to revise (never an edit); a built-in is read only and offers a variant', async () => {
    render(<SkillLibrary client={withRows(row({ name: 'webterm-mine', origin: 'central' }), row({ name: 'webterm-b', origin: 'builtin' }))} chat={{ createConversation: vi.fn(async () => ({}) as never) }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-mine 1' }))
    expect(screen.getByRole('button', { name: 'Ask the agent to revise webterm-mine' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View webterm-b 1' }))
    const detail = screen.getByRole('article', { name: 'webterm-b 1 details' })
    expect(within(detail).getByText('Built-in, read only')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ask the agent to revise/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ask the agent for a variant webterm-b' })).toBeTruthy()
  })

  it('the empty state explains how skills are written', async () => {
    render(<SkillLibrary client={withRows()} />)
    expect((await screen.findAllByText(/Skills are written with the agent: press Write with an agent/)).length).toBeGreaterThan(0)
  })
})
