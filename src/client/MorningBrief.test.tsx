/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MorningBrief, { openTarget, type MorningBriefProps } from './MorningBrief'
import { listCommands } from './commandRegistry'
import type { BriefResponse } from '../server/brief/brief.service'

const T0 = 1_700_000_000_000
const brief = (over: Partial<BriefResponse> = {}): BriefResponse => ({
  since: T0, generatedAt: T0 + 1, headSeq: 3, visitStartedAt: T0 + 1, dismissed: false,
  lines: [
    { id: 'stuck:a', category: 'stuck', text: 'Claude in api needs your input', target: { kind: 'node', nodeId: 'a' } },
    { id: 'gates:needs_you', category: 'gates', text: '1 approval or blocked task waiting in the Inbox', target: { kind: 'inbox' } },
    { id: 'checkpoints:w1', category: 'checkpoints', text: '2 checkpoints in api', target: { kind: 'diff', workspaceId: 'w1' } },
    { id: 'cost:total', category: 'cost', text: '1.0k input / 10 output tokens across 1 call, $0.01', target: null },
  ],
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
let props: MorningBriefProps
function respond(body: BriefResponse): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  props = { onFocusNode: vi.fn(), onOpenInbox: vi.fn(), onOpenDiff: vi.fn() }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('shows the card on open with headings, and each line opens its target', async () => {
  respond(brief())
  render(<MorningBrief {...props} />)
  expect(await screen.findByRole('dialog', { name: 'Morning brief' })).toBeTruthy()
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/brief')
  expect(screen.getByText('Needs you')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Claude in api needs your input' }))
  fireEvent.click(screen.getByRole('button', { name: /waiting in the Inbox/ }))
  fireEvent.click(screen.getByRole('button', { name: '2 checkpoints in api' }))
  expect(props.onFocusNode).toHaveBeenCalledWith('a')
  expect(props.onOpenInbox).toHaveBeenCalledTimes(1)
  expect(props.onOpenDiff).toHaveBeenCalledWith('w1')
  expect(screen.queryByRole('button', { name: /tokens/ })).toBeNull() // usage line has no target
})

test('dismiss hides the card and persists it server-side', async () => {
  respond(brief())
  render(<MorningBrief {...props} />)
  await screen.findByRole('dialog')
  respond(brief({ dismissed: true }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss morning brief' })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/brief/dismiss')
  expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('POST')
})

test('an already dismissed (or empty) brief stays hidden until ⌘K "Brief: Show morning brief"', async () => {
  respond(brief({ dismissed: true }))
  render(<MorningBrief {...props} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.queryByRole('dialog')).toBeNull()
  const cmd = listCommands().find((c) => c.id === 'brief.show')
  expect(cmd?.label).toBe('Brief: Show morning brief')
  respond(brief({ dismissed: true, lines: [] }))
  await act(async () => { cmd!.run!() })
  expect(await screen.findByText('Nothing new since you were last here.')).toBeTruthy()
  // Closing a re-shown, already dismissed brief does not POST again.
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss morning brief' }))
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('openTarget ignores a null target', () => {
  openTarget(null, props)
  expect(props.onFocusNode).not.toHaveBeenCalled()
})
