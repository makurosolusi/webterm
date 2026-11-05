/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MorningBrief, { openTarget, type MorningBriefProps } from './MorningBrief'
import { listCommands } from './commandRegistry'
import type { BriefResponse } from '../server/brief/brief.service'
import type { HandoffWorkspace } from './MorningBriefContinue'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

const T0 = 1_700_000_000_000
const brief = (over: Partial<BriefResponse> = {}): BriefResponse => ({
  since: T0, generatedAt: T0 + 1, headSeq: 3, visitStartedAt: T0 + 1, dismissed: false, llm: false,
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
let briefs: BriefResponse[]
let handoff: HandoffWorkspace[]
let narrative: unknown
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
function respond(body: BriefResponse): void { briefs.push(body) }
const calls = (prefix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix))
const briefCalls = () => fetchMock.mock.calls.filter((c) => /^\/api\/brief(\/dismiss|\/llm)?/.test(String(c[0])) && !String(c[0]).includes('narrative'))

beforeEach(() => {
  briefs = []
  handoff = []
  narrative = { narrative: null, reason: 'off' }
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/handoff') return ok({ workspaces: handoff })
    if (path === '/api/handoff/continue') return ok({ results: [{ nodeId: 'n1', injected: JSON.parse(String(init?.body)).workspaceId === 'w1' }] })
    if (path === '/api/brief/narrative') return ok(narrative)
    return ok(briefs.shift() ?? brief())
  })
  vi.stubGlobal('fetch', fetchMock)
  props = { onFocusNode: vi.fn(), onOpenInbox: vi.fn(), onOpenDiff: vi.fn(), onOpenWorkspace: vi.fn() }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('shows the card on open with headings, and each line opens its target', async () => {
  respond(brief())
  render(<MorningBrief {...props} />)
  expect(await screen.findByRole('dialog', { name: 'Morning brief' })).toBeTruthy()
  expect(calls('/api/brief')).toHaveLength(1)
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
  const close = screen.getByRole('button', { name: 'Dismiss morning brief' })
  expect(close.hasAttribute('title')).toBe(false)
  expect(tipOf(close)).toBe('Dismiss morning brief')
  respond(brief({ dismissed: true }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss morning brief' })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  const dismiss = calls('/api/brief/dismiss')
  expect(dismiss).toHaveLength(1)
  expect((dismiss[0]?.[1] as RequestInit).method).toBe('POST')
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
  expect(briefCalls()).toHaveLength(2)
})

test('openTarget ignores a null target', () => {
  openTarget(null, props)
  expect(props.onFocusNode).not.toHaveBeenCalled()
})

test('AI paragraph: off by default (never fetched), shown above the unchanged lines when on', async () => {
  respond(brief())
  const { unmount } = render(<MorningBrief {...props} />)
  await screen.findByRole('dialog')
  expect(calls('/api/brief/narrative')).toHaveLength(0)
  expect((screen.getByRole('checkbox', { name: 'AI summary in the morning brief' }) as HTMLElement).getAttribute('aria-checked')).toBe('false')
  unmount()
  narrative = { narrative: 'One agent needs your input and 2 checkpoints landed.', reason: 'ok' }
  respond(brief({ llm: true }))
  render(<MorningBrief {...props} />)
  expect((await screen.findByTestId('brief-narrative')).textContent).toBe('One agent needs your input and 2 checkpoints landed.')
  expect(screen.getByRole('button', { name: 'Claude in api needs your input' })).toBeTruthy()
})

test('AI toggle posts on/off', async () => {
  respond(brief())
  render(<MorningBrief {...props} />)
  await screen.findByRole('dialog')
  respond(brief({ llm: true }))
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'AI summary in the morning brief' })) })
  expect(calls('/api/brief/llm/on')).toHaveLength(1)
  expect((calls('/api/brief/llm/on')[0]?.[1] as RequestInit).method).toBe('POST')
})

test('Continue from yesterday: button and ⌘K command post once per click and open the workspace', async () => {
  handoff = [{ id: 'w1', name: 'api', agents: [{ nodeId: 'n1', title: 'brisk-otter', card: null }] }]
  respond(brief({ lines: [] }))
  render(<MorningBrief {...props} />)
  expect(await screen.findByText('Continue from yesterday')).toBeTruthy() // shown even with no brief lines
  expect(screen.getByText('brisk-otter')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue from yesterday in api' })) })
  expect(await screen.findByText('Handed off to 1 agent')).toBeTruthy()
  const post = calls('/api/handoff/continue')
  expect(post).toHaveLength(1)
  expect(JSON.parse(String((post[0]?.[1] as RequestInit).body))).toEqual({ workspaceId: 'w1' })
  expect(props.onOpenWorkspace).toHaveBeenCalledWith('w1')
  const cmd = listCommands().find((c) => c.id === 'handoff.continue.w1')
  expect(cmd?.label).toBe('Agents: Continue from yesterday in api')
  await act(async () => { cmd!.run!() })
  expect(calls('/api/handoff/continue')).toHaveLength(2)
})

test('a new inline onOpenWorkspace per parent render does not re-register commands (no update loop)', async () => {
  handoff = [{ id: 'w1', name: 'api', agents: [{ nodeId: 'n1', title: 'brisk-otter', card: null }] }]
  respond(brief())
  const opened: string[] = []
  const { rerender } = render(<MorningBrief {...props} onOpenWorkspace={(ws) => opened.push(ws)} />)
  await screen.findByText('Continue from yesterday')
  const before = listCommands().find((c) => c.id === 'handoff.continue.w1')
  rerender(<MorningBrief {...props} onOpenWorkspace={(ws) => opened.push(`new:${ws}`)} />)
  expect(listCommands().find((c) => c.id === 'handoff.continue.w1')).toBe(before)
  await act(async () => { before!.run!() })
  expect(opened).toEqual(['new:w1']) // the latest callback still runs
})
