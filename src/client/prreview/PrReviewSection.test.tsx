/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrReviewSection } from './PrReviewSection'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

type Call = { url: string; method: string; body: unknown }
function stubApi(answer: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const a = answer(c)
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 })
  }))
  return calls
}

// test-only fixtures
const draft = { itemId: 'gate_1', title: 'Post review to o/r#7: 2 findings', pr: 7, url: 'https://github.com/o/r/pull/7', findings: 2, inline: 1, expiresAt: null }
const job = (status: string) => ({ id: 'j1', repo: '/r', pr: 7, status, error: null, itemId: null, findings: 0, startedAt: 1 })

describe('PR review section', () => {
  it('starts a review for the typed PR number', async () => {
    const calls = stubApi((c) => (c.method === 'POST' ? { status: 202, body: job('running') } : { body: { jobs: [], drafts: [] } }))
    render(<PrReviewSection root="/r" gh pollMs={0} />)
    fireEvent.change(screen.getByLabelText('Pull request number'), { target: { value: '#7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review PR #7' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/prreview', method: 'POST', body: { repo: '/r', pr: 7 } })
  })

  it('lists drafts and posts only when Post review is clicked', async () => {
    const calls = stubApi((c) => (c.method === 'POST' ? { body: { url: 'https://github.com/o/r/pull/7#pullrequestreview-1' } } : { body: { jobs: [job('drafted')], drafts: [draft] } }))
    render(<PrReviewSection root="/r" gh pollMs={0} />)
    expect(await screen.findByText('PR #7: 2 findings, 1 inline')).toBeTruthy()
    expect(screen.getByText('PR #7: Draft in the Central chat')).toBeTruthy()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(tipOf(screen.getByRole('button', { name: 'Post review' }))).toBe('Posts one review with inline comments to GitHub. Cannot be undone.')
    fireEvent.click(screen.getByRole('button', { name: 'Post review' }))
    expect(await screen.findByText('Review posted: https://github.com/o/r/pull/7#pullrequestreview-1')).toBeTruthy()
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/prreview/gate_1/post'])
  })

  it('without gh the review button is off and says why', async () => {
    stubApi(() => ({ body: { jobs: [], drafts: [] } }))
    render(<PrReviewSection root="/r" gh={false} pollMs={0} />)
    fireEvent.change(screen.getByLabelText('Pull request number'), { target: { value: '7' } })
    expect((screen.getByRole('button', { name: 'Review PR #7' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Install the GitHub CLI (gh) to review pull requests.')).toBeTruthy()
  })
})
