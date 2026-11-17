/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NodeActionsProvider } from '../nodeActions'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillLibrary from './SkillLibrary'

beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(cleanup)

const row = (name: string, audience: 'central' | 'canvas', over: Partial<SkillReviewRow['record']> = {}): SkillReviewRow => ({
  record: { name, version: '1', sha256: null, status: 'active', origin: 'human', audience, caps: [], createdAt: 1, proposedBy: 'human:root', approvedBy: 'human:root', approvedAt: 1, evalScore: null, enabled: true, ...over },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, description: `About ${name}.`, body: '1. Do it.',
})
const rows = [row('webterm-rule', 'central'), row('webterm-howto', 'canvas')]
const show = (list = rows, openSkillAuthor?: (t?: string) => string) => {
  const client = fakeClient({ listSkills: vi.fn(async () => list) })
  render(<NodeActionsProvider value={{ onSession: () => {}, onToggleHideLinks: () => {}, openSkillAuthor }}><SkillLibrary client={client} /></NodeActionsProvider>)
  return client
}
const section = async (name: string) => within(await screen.findByRole('region', { name }))

describe('two skill sections', () => {
  it('splits the library into Central skills and Canvas skills, each with its purpose, badge and rows', async () => {
    show()
    const central = await section('Central skills')
    expect(central.getByText('webterm-rule')).toBeTruthy()
    expect(central.queryByText('webterm-howto')).toBeNull()
    expect(central.getByText(/Rules Central follows/)).toBeTruthy()
    expect(central.getByText('Central')).toBeTruthy()
    const canvas = await section('Canvas skills')
    expect(canvas.getByText('webterm-howto')).toBeTruthy()
    expect(canvas.queryByText('webterm-rule')).toBeNull()
    expect(canvas.getByText(/Reusable procedures for agents on the canvas/)).toBeTruthy()
    expect(canvas.getByText('Canvas')).toBeTruthy()
  })

  it('shows a per-section empty state', async () => {
    show([row('webterm-howto', 'canvas')])
    expect((await section('Central skills')).getByText('No Central skills yet')).toBeTruthy()
  })

  it('the canvas agent-author node button stays in the Canvas section; the Central section has its own chat-based author', async () => {
    show(rows, () => 'node-1')
    expect((await section('Canvas skills')).getByRole('button', { name: 'Write with an agent' })).toBeTruthy()
    expect((await section('Central skills')).queryByRole('button', { name: 'Write with an agent' })).toBeNull()
    expect((await section('Central skills')).getByRole('button', { name: 'Write with an agent (Central)' })).toBeTruthy()
    expect((await section('Canvas skills')).queryByRole('button', { name: 'Write with an agent (Central)' })).toBeNull()
  })

  it('the per-skill node edit is for a canvas skill; a central skill offers the Central chat author instead', async () => {
    show(rows, () => 'node-1')
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-rule 1' }))
    expect(screen.queryByRole('button', { name: 'Edit with an agent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit with an agent webterm-rule' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View webterm-howto 1' }))
    expect(await screen.findByRole('button', { name: 'Edit with an agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit with an agent webterm-howto' })).toBeNull()
  })
})

describe('kind on create, detail and fork', () => {
  it('New skill from a section preselects that kind, shows what it means, and sends it', async () => {
    const client = show()
    fireEvent.click(await within(await screen.findByRole('region', { name: 'Central skills' })).findByRole('button', { name: 'New skill (Central)' }))
    const form = screen.getByRole('form', { name: 'New skill draft' })
    expect(within(form).getByRole('combobox', { name: 'Kind' }).textContent).toContain('Central skill')
    expect(within(form).getByText(/Canvas agents never see it/)).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'my-rule' } })
    fireEvent.change(within(form).getByLabelText('When to use'), { target: { value: 'Use when asked.' } })
    fireEvent.change(within(form).getByLabelText('Instructions (markdown)'), { target: { value: '1. Do it.' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(client.createSkill).toHaveBeenCalledWith({ name: 'webterm-my-rule', description: 'Use when asked.', body: '1. Do it.', caps: [], audience: 'central' }))
  })

  it('a canvas section opens the form on Canvas skill', async () => {
    show()
    fireEvent.click(await within(await screen.findByRole('region', { name: 'Canvas skills' })).findByRole('button', { name: 'New skill (Canvas)' }))
    expect(within(screen.getByRole('form', { name: 'New skill draft' })).getByRole('combobox', { name: 'Kind' }).textContent).toContain('Canvas skill')
  })

  it('detail shows the badge and meaning; Duplicate sends the selected kind (default: the skill own kind)', async () => {
    const client = show()
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-howto 1' }))
    const detail = await screen.findByRole('article', { name: 'webterm-howto 1 details' })
    expect(within(detail).getAllByText(/Central never loads it/).length).toBeGreaterThan(0)
    expect(within(detail).getByRole('combobox', { name: 'Kind' }).textContent).toContain('Canvas skill')
    fireEvent.click(within(detail).getByRole('button', { name: 'Duplicate and edit' }))
    await waitFor(() => expect(client.forkSkill).toHaveBeenCalledWith('webterm-howto', 'canvas'))
  })

  it('Edit shows the fixed kind (no select) and does not send an audience', async () => {
    const client = show()
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-howto 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit skill' })
    expect(within(form).queryByRole('combobox', { name: 'Kind' })).toBeNull()
    expect(within(form).getByText(/keeps its kind/)).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('Instructions (markdown)'), { target: { value: '1. Changed.' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }))
    await waitFor(() => expect(client.editSkill).toHaveBeenCalledWith('webterm-howto', { description: 'About webterm-howto.', body: '1. Changed.', caps: [] }))
  })
})

describe('review card', () => {
  it('shows the kind badge on a draft waiting for review', async () => {
    show([row('webterm-draft', 'canvas', { status: 'pending_approval', origin: 'agent' })])
    const card = await screen.findByRole('article', { name: 'webterm-draft 1' })
    expect(within(card).getByText('Canvas')).toBeTruthy()
  })
})
