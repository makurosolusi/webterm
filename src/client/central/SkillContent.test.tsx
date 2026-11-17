/** @vitest-environment jsdom */
// Detail content per template section, unified diff prefixes, and the review card's block order and approval gate.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeClient } from './centralFixtures.testutil'
import type { SkillReviewRow } from './centralControlTypes'
import SkillContent, { parseSections } from './SkillContent'
import SkillDetail from './SkillDetail'
import SkillDiff from './SkillDiff'
import SkillReviewList from './SkillReview'

afterEach(cleanup)

const BODY = '## Purpose\nShip a release.\n\n## Steps\n1. Run `bun test`.\n2. Tag it.\n\n## Do not\n- Push without asking.\n\n## Glossary\nRC means release candidate.'

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-x', version: '2', sha256: null, status: 'pending_approval', origin: 'agent', caps: [], createdAt: 1_700_000_000_000, proposedBy: 'a', approvedBy: null, approvedAt: null, evalScore: null, audience: 'central', ...over },
  lint: { ok: true, findings: [] }, diff: '-old\n+new', canRollback: false, description: 'Demo.', body: BODY, ...extra,
})

describe('SkillContent', () => {
  it('renders Steps as a numbered list and keeps unknown sections', () => {
    render(<SkillContent body={BODY} />)
    const steps = screen.getByRole('heading', { name: 'Steps' }).parentElement as HTMLElement
    const items = within(steps).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['1. Run bun test.', '2. Tag it.'])
    expect(steps.querySelector('code')?.textContent).toBe('bun test')
    expect(screen.getByRole('heading', { name: 'Glossary' })).toBeTruthy()
    expect(screen.getByText('RC means release candidate.')).toBeTruthy()
    expect(screen.queryByText(/^##/)).toBeNull()
  })

  it('keeps text before the first heading and parses sections', () => {
    expect(parseSections('Intro\n## A\nx').map((s) => s.heading)).toEqual([null, 'A'])
  })

  it('clamps a long body behind Show all', () => {
    render(<SkillContent body={Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')} />)
    const toggle = screen.getByRole('button', { name: 'Show all' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })
})

describe('SkillDetail metadata', () => {
  it('shows kind, origin, version, last changed and enabled', () => {
    render(<SkillDetail row={row({ status: 'active', approvedAt: 1_700_000_000_000 })} client={fakeClient()} onClose={vi.fn()} onChanged={vi.fn()} />)
    const meta = within(screen.getByLabelText('Skill details'))
    for (const k of ['Kind', 'Origin', 'Version', 'Last changed', 'Enabled']) expect(meta.getByText(k)).toBeTruthy()
    expect(meta.getByText('Agent')).toBeTruthy()
  })
})

describe('SkillDiff', () => {
  it('keeps +/- prefixes and labels changed lines without color', () => {
    render(<SkillDiff text={'@@ -1 +1 @@\n-old\n+new\n same'} lineNumbers />)
    const pre = screen.getByLabelText('Diff')
    expect(pre.textContent).toContain('removed line: -old')
    expect(pre.textContent).toContain('added line: +new')
    expect(pre.querySelector('[data-diff="hunk"]')).toBeTruthy()
  })
})

describe('SkillReview card', () => {
  it('orders summary, checks, diff, approval; Approve is enabled at once (one click, no phrase)', () => {
    const client = fakeClient()
    render(<SkillReviewList rows={[row({}, { lint: { ok: true, findings: ['name is long'] } })]} client={client} onDone={vi.fn()} />)
    const card = screen.getByRole('article', { name: 'webterm-x 2' })
    const order = [card.querySelector('.skd-note'), card.querySelector('.skd-lint'), card.querySelector('.skd-diff'), card.querySelector('.skd-approval')]
    expect(order.every(Boolean)).toBe(true)
    for (let i = 1; i < order.length; i++) expect((order[i - 1] as Element).compareDocumentPosition(order[i] as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(card).getByRole('status').textContent).toBe('Pass: Lint passed')
    const approve = within(card).getByRole('button', { name: 'Approve skill webterm-x 2' }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    expect(within(card).queryByRole('textbox')).toBeNull()
    expect(within(card).queryByText(/above to enable Approve/)).toBeNull()
  })

  it('shows a failed check as text and keeps Approve locked', () => {
    render(<SkillReviewList rows={[row({}, { lint: { ok: false, findings: ['missing Steps'] } })]} client={fakeClient()} onDone={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Fail: Lint failed')
    expect(screen.getByText('missing Steps')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Approve skill webterm-x 2' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Approve is locked until the checks pass.')).toBeTruthy()
  })
})
