/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NodeActionsProvider } from '../nodeActions'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import { OPEN_SIDE_BAR_VIEW } from '../sideBar/sideBar.open'
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

describe('Control > Skills is Central only', () => {
  it('lists Central skills under one heading and never renders a Canvas section or row', async () => {
    show()
    const lib = await section('Central skills')
    expect(lib.getByText('webterm-rule')).toBeTruthy()
    expect(lib.getByText(/Rules Central follows/)).toBeTruthy()
    expect(lib.queryByText('webterm-howto')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Canvas skills' })).toBeNull()
    expect(screen.queryByText('webterm-howto')).toBeNull()
  })

  it('a library with only canvas skills reads as empty', async () => {
    show([row('webterm-howto', 'canvas')])
    expect(await screen.findByText(/^No skills yet/)).toBeTruthy()
    expect(screen.queryByText('webterm-howto')).toBeNull()
  })

  it('has a single Write with an agent (Central), no canvas author button, and revise goes through the Central chat', async () => {
    show(rows, () => 'node-1')
    expect(await screen.findByRole('button', { name: 'Write with an agent (Central)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Write with an agent \(Canvas\)/ })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-rule 1' }))
    expect(screen.queryByRole('button', { name: 'Ask the agent to revise' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ask the agent to revise webterm-rule' })).toBeTruthy()
  })

  it('points to the canvas Skills panel and asks the side bar to show it', async () => {
    const seen = vi.fn()
    window.addEventListener(OPEN_SIDE_BAR_VIEW, seen)
    show()
    expect(await screen.findByText(/Skills for agents on the canvas live in the Skills panel in the canvas sidebar\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas Skills' }))
    expect((seen.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ view: 'skills' })
    window.removeEventListener(OPEN_SIDE_BAR_VIEW, seen)
  })
})

describe('kind in the detail', () => {
  it('detail shows the badge and meaning, with no kind select and no duplicate', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-rule 1' }))
    const detail = await screen.findByRole('article', { name: 'webterm-rule 1 details' })
    expect(within(detail).getAllByText(/Canvas agents never see it/).length).toBeGreaterThan(0)
    expect(within(detail).queryByRole('combobox')).toBeNull()
    expect(within(detail).queryByRole('button', { name: /Duplicate|^Edit$/ })).toBeNull()
  })
})

describe('review card', () => {
  it('shows the kind badge on a Central draft waiting for review', async () => {
    show([row('webterm-draft', 'central', { status: 'pending_approval', origin: 'agent' })])
    const card = await screen.findByRole('article', { name: 'webterm-draft 1' })
    expect(within(card).getByText('Central')).toBeTruthy()
  })
})
