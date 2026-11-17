/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillLibrary from './SkillLibrary'

beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(cleanup)

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-x', version: '1', sha256: null, status: 'active', origin: 'human', caps: [], createdAt: 1, proposedBy: null, approvedBy: 'u', approvedAt: 1, evalScore: null, audience: 'central' as const, ...over },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, description: 'Does a thing.', body: 'body text', ...extra,
})
const rowBtn = (name: string) => screen.getByRole('button', { name: `View ${name} 1` })

describe('SkillLibrary toolbar', () => {
  const rows = [row({ name: 'a' }), row({ name: 'b', enabled: false }), row({ name: 'c', status: 'pending_approval' })]
  const mount = () => render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => rows) })} />)

  it('filters by status and shows counts that follow the search', async () => {
    mount()
    await screen.findByLabelText('Search skills')
    const group = screen.getByRole('group', { name: 'Filter skills' })
    expect(within(group).getByRole('button', { name: /^All/ }).textContent).toBe('All3')
    expect(within(group).getByRole('button', { name: /^Active/ }).textContent).toBe('Active1')
    expect(within(group).getByRole('button', { name: /^Disabled/ }).textContent).toBe('Disabled1')
    expect(within(group).getByRole('button', { name: /^Needs review/ }).textContent).toBe('Needs review1')
    fireEvent.click(within(group).getByRole('button', { name: /^Disabled/ }))
    expect(screen.queryByRole('button', { name: 'View a 1' })).toBeNull()
    expect(rowBtn('b')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'zzz' } })
    expect(within(group).getByRole('button', { name: /^All/ }).textContent).toBe('All0')
    expect(screen.getByText(/No skills match “zzz”/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(rowBtn('a')).toBeTruthy()
    expect(rowBtn('b')).toBeTruthy()
  })

  it('shows badges only for non-normal state', async () => {
    mount()
    expect((await screen.findByRole('button', { name: 'View a 1' })).textContent).not.toMatch(/Active|Disabled|Pending/)
    expect(rowBtn('b').textContent).toContain('Disabled')
    expect(rowBtn('c').textContent).toContain('Pending review')
  })
})

describe('SkillLibrary inline switch', () => {
  it('flips optimistically, calls the API and reloads', async () => {
    const setSkillEnabled = vi.fn(async () => undefined)
    const listSkills = vi.fn(async () => [row({ name: 'a' })])
    render(<SkillLibrary client={fakeClient({ listSkills, setSkillEnabled })} />)
    const sw = await screen.findByRole('switch', { name: 'Enabled: a' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2))
    expect(setSkillEnabled).toHaveBeenCalledWith('a', false)
  })

  it('rolls back and shows an inline alert when the server refuses', async () => {
    const setSkillEnabled = vi.fn().mockRejectedValue(new InboxApiError('nope', 500, 'internal_error'))
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ name: 'a' })]), setSkillEnabled })} />)
    const sw = await screen.findByRole('switch', { name: 'Enabled: a' })
    fireEvent.click(sw)
    expect((await screen.findByRole('alert')).textContent).toBeTruthy()
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('has no switch for a draft', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ name: 'c', status: 'pending_approval' })]) })} />)
    await screen.findByRole('button', { name: 'View c 1' })
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('SkillLibrary accordion', () => {
  const rows = [row({ name: 'a' }), row({ name: 'b' }), row({ name: 'k' })]
  const mount = () => render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => rows) })} />)

  it('opens the detail inside the clicked row, one at a time', async () => {
    mount()
    const a = await screen.findByRole('button', { name: 'View a 1' })
    fireEvent.click(a)
    expect(a.getAttribute('aria-expanded')).toBe('true')
    const li = a.closest('li') as HTMLElement
    const detail = screen.getByRole('article', { name: 'a 1 details' })
    expect(li.contains(detail)).toBe(true)
    expect(li.nextElementSibling?.contains(detail)).toBe(false)
    fireEvent.click(rowBtn('k'))
    expect(screen.getAllByRole('article')).toHaveLength(1)
    const k = screen.getByRole('article', { name: 'k 1 details' })
    expect(rowBtn('k').closest('li')?.contains(k)).toBe(true)
    expect(a.getAttribute('aria-expanded')).toBe('false')
  })

  it('Esc closes the detail and returns focus to the row', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'View a 1' }))
    fireEvent.keyDown(screen.getByRole('article', { name: 'a 1 details' }), { key: 'Escape' })
    expect(screen.queryByRole('article')).toBeNull()
    expect(document.activeElement).toBe(rowBtn('a'))
  })

  it('the Close details button also returns focus to the row', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'View b 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(document.activeElement).toBe(rowBtn('b'))
  })
})

describe('SkillLibrary drafts', () => {
  it('renders no drafts card at all when Central has no drafts', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ name: 'a' })]) })} />)
    await screen.findByRole('button', { name: 'View a 1' })
    expect(screen.queryByRole('region', { name: /Drafts from Central/ })).toBeNull()
    expect(screen.queryByText(/drafts? to review/)).toBeNull()
  })

  it('shows an "N drafts to review" badge that toggles the panel', async () => {
    const draft = row({ name: 'd', origin: 'central', status: 'pending_approval' })
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [draft]) })} />)
    const badge = await screen.findByRole('button', { name: '1 draft to review' })
    expect(screen.getByRole('region', { name: 'Drafts from Central' })).toBeTruthy()
    fireEvent.click(badge)
    expect(screen.queryByRole('region', { name: 'Drafts from Central' })).toBeNull()
  })
})

describe('SkillLibrary states', () => {
  it('shows a 3-row skeleton while loading, marked busy', () => {
    const { container } = render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(() => new Promise<SkillReviewRow[]>(() => undefined)) })} />)
    expect(container.querySelectorAll('.ccp-skill-skel')).toHaveLength(3)
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('shows the Central-only empty line when only canvas skills exist', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ name: 'a', audience: 'canvas' })]) })} />)
    expect(await screen.findByText(/^No skills yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'View a 1' })).toBeNull()
  })

  it('uses a secondary, not primary, Write with an agent button', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row({ name: 'a' })]) })} />)
    const btn = await screen.findByRole('button', { name: 'Write with an agent (Central)' })
    expect(btn.getAttribute('data-variant')).toBe('secondary')
  })
})
