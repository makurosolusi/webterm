/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillLibrary from './SkillLibrary'
import { SkillCreateError, createSkillRequest } from './skillCreateApi'

// Radix Checkbox measures itself with ResizeObserver, which jsdom lacks.
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-x', version: '1', sha256: null, status: 'active', origin: 'builtin', caps: ['portfolio.read'], createdAt: 1, proposedBy: null, approvedBy: 'system:builtin', approvedAt: 1, evalScore: null, audience: 'central' as const, ...over },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, description: 'Summarize project status.', body: '1. Read the portfolio.', ...extra,
})
const withRows = (...rows: SkillReviewRow[]) => fakeClient({ listSkills: vi.fn(async () => rows) })

describe('SkillLibrary browse', () => {
  it('lists name, description, origin, status and version', async () => {
    render(<SkillLibrary client={withRows(row())} />)
    const item = (await screen.findByText('Summarize project status.')).closest('li') as HTMLElement
    expect(within(item).getByText('webterm-x')).toBeTruthy()
    expect(within(item).getByText('builtin')).toBeTruthy()
    expect(within(item).getByText('active')).toBeTruthy()
    expect(within(item).getByText('1')).toBeTruthy()
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
    expect(screen.getByText('No skills match your search.')).toBeTruthy()
  })

  it('opens a read-only detail with the body; builtin says so', async () => {
    render(<SkillLibrary client={withRows(row())} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-x 1' }))
    const detail = screen.getByRole('article', { name: 'webterm-x 1 details' })
    expect(within(detail).getByLabelText('Instructions (markdown)').textContent).toBe('1. Read the portfolio.')
    expect(within(detail).getByText('Built-in skills are read-only.')).toBeTruthy()
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
    expect(await screen.findByText('No skills yet')).toBeTruthy()
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

  it('when skills are off it shows the reason and no New skill button', async () => {
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => { throw new InboxApiError('off', 503, 'skills_off') }) })} />)
    expect(await screen.findByText(/Central skills are off/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New skill' })).toBeNull()
  })
})

describe('SkillLibrary new skill form', () => {
  const open = async (client = withRows()) => {
    render(<SkillLibrary client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New skill (Canvas)' }))
    return client
  }
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Webterm-My-Skill' } })
    fireEvent.change(screen.getByLabelText('When to use'), { target: { value: 'Use when asked.' } })
    fireEvent.change(screen.getByLabelText('Instructions (markdown)'), { target: { value: '1. Do it.' } })
  }
  const submit = () => screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement

  it('is disabled until valid, and shows counters', async () => {
    await open()
    expect(submit().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('When to use'), { target: { value: 'abc' } })
    expect(screen.getByText('3 / 300')).toBeTruthy()
    expect(screen.getByText('0 / 4000')).toBeTruthy()
    fill()
    expect(submit().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad Name!' } })
    expect(submit().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Instructions (markdown)'), { target: { value: 'x'.repeat(4001) } })
    expect(screen.getByText('4001 / 4000').className).toContain('ccp-error')
  })

  it('sends the prefixed name and chosen caps, then closes and reloads', async () => {
    const client = await open()
    fill()
    fireEvent.click(screen.getByRole('checkbox', { name: 'skill.load' }))
    fireEvent.click(submit())
    await waitFor(() => expect(client.createSkill).toHaveBeenCalledWith({ name: 'webterm-my-skill', description: 'Use when asked.', body: '1. Do it.', caps: ['skill.load'], audience: 'canvas' }))
    expect(await screen.findByText('Draft webterm-my-skill saved. Review it below.')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'New skill draft' })).toBeNull()
    await waitFor(() => expect(client.listSkills).toHaveBeenCalledTimes(2))
  })

  it('shows lint issues as readable lines, never raw JSON, and keeps the text', async () => {
    const client = fakeClient({ listSkills: vi.fn(async () => []), createSkill: vi.fn(async () => { throw new SkillCreateError(400, 'invalid', ['url', 'danger']) }) })
    await open(client)
    fill()
    fireEvent.click(submit())
    const alert = await screen.findByText('Fix these and try again:')
    const box = alert.closest('[role="alert"]') as HTMLElement
    expect(within(box).getByText('Remove links from the text.')).toBeTruthy()
    expect(within(box).getByText('Remove shell commands from the text.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/[{}]|issues|http_|invalid\b/)
    expect((screen.getByLabelText('Instructions (markdown)') as HTMLTextAreaElement).value).toBe('1. Do it.')
    await waitFor(() => expect(submit().disabled).toBe(false))
  })

  it('maps a duplicate (409 limit) to a plain sentence', async () => {
    const client = fakeClient({ listSkills: vi.fn(async () => []), createSkill: vi.fn(async () => { throw new SkillCreateError(409, 'limit', []) }) })
    await open(client)
    fill()
    fireEvent.click(submit())
    expect(await screen.findByText(/already waiting for review/)).toBeTruthy()
  })

  it('disables the form while saving', async () => {
    let finish = () => {}
    const client = fakeClient({ listSkills: vi.fn(async () => []), createSkill: vi.fn(() => new Promise<void>((r) => { finish = r })) })
    await open(client)
    fill()
    fireEvent.click(submit())
    const busy = await screen.findByRole('button', { name: 'Saving…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true)
    finish()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull())
  })

  it('cancel closes the form without calling the server', async () => {
    const client = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'New skill draft' })).toBeNull()
    expect(client.createSkill).not.toHaveBeenCalled()
  })
})

describe('createSkillRequest', () => {
  it('turns a 400 body into a SkillCreateError with issue codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid', issues: ['url'] }), { status: 400 })))
    const err = await createSkillRequest('/x', { name: 'webterm-a', description: 'd', body: 'b', caps: [], audience: 'canvas' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SkillCreateError)
    expect(err).toMatchObject({ status: 400, code: 'invalid', issues: ['url'] })
  })

  it('posts JSON and resolves on 201', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', f)
    await createSkillRequest('/x', { name: 'webterm-a', description: 'd', body: 'b', caps: [], audience: 'canvas' })
    expect(f).toHaveBeenCalledWith('/x', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'webterm-a', description: 'd', body: 'b', caps: [], audience: 'canvas' }) }))
  })
})
