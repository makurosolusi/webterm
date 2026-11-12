/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatSessionSummary } from '../../shared/agentChat.wire'
import { SessionPicker } from './sessionPicker'

afterEach(cleanup)
// jsdom lacks the ResizeObserver the Radix popper calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const NOW = Date.now()
const SESSIONS: AgentChatSessionSummary[] = [ // test-only
  { sessionId: 's1', title: 'Fix login bug', updatedAt: NOW - 5 * 60_000, current: true },
  { sessionId: 's2', title: 'Refactor footer', updatedAt: NOW - 3 * 3_600_000, current: false },
]
const trigger = () => screen.getByRole('button', { name: 'Conversation history' })
const open = () => fireEvent.click(trigger())
const noop = vi.fn(async () => undefined)

describe('SessionPicker', () => {
  it('loads on open and lists title + relative time, the current one marked and not resumable', async () => {
    render(<SessionPicker loadSessions={async () => SESSIONS} onResume={noop} onNew={noop} />)
    open()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Loading conversations…')
    const list = await screen.findByRole('list', { name: 'Past conversations' })
    const items = within(list).getAllByRole('button')
    expect(items.map((b) => b.textContent)).toEqual(['Fix login bugCurrent · 5m ago', 'Refactor footer3h ago'])
    expect(items[0].getAttribute('aria-current')).toBe('true')
    expect((items[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('filters by search and shows the no-match / empty states', async () => {
    const loadSessions = vi.fn().mockResolvedValueOnce(SESSIONS).mockResolvedValueOnce([])
    render(<SessionPicker loadSessions={loadSessions} onResume={noop} onNew={noop} />)
    open()
    await screen.findByRole('list')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'FOOTER' } })
    expect(within(screen.getByRole('list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Refactor footer3h ago'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching conversations')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    open()
    expect(await screen.findByText('No past conversations yet')).toBeTruthy()
  })

  it('shows the load error with Retry', async () => {
    const loadSessions = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(SESSIONS)
    render(<SessionPicker loadSessions={loadSessions} onResume={noop} onNew={noop} />)
    open()
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load conversations: HTTP 500')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('list')).toBeTruthy()
  })

  it('resumes a past conversation and closes; a failure stays open with the error', async () => {
    let reject: (e: Error) => void = () => undefined
    const onResume = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_r, j) => { reject = j }))
      .mockResolvedValueOnce(undefined)
    render(<SessionPicker loadSessions={async () => SESSIONS} onResume={onResume} onNew={noop} />)
    open()
    fireEvent.click(await screen.findByRole('button', { name: /Refactor footer/ }))
    expect(onResume).toHaveBeenCalledWith('s2')
    expect(screen.getByRole('button', { name: /Refactor footer/ }).textContent).toContain('Resuming…')
    expect(screen.getByRole('button', { name: /Refactor footer/ }).getAttribute('aria-busy')).toBe('true')
    await act(async () => reject(new Error('session locked')))
    expect(screen.getByRole('alert').textContent).toBe('Could not resume the conversation: session locked')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Refactor footer/ })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it('New conversation calls onNew and closes', async () => {
    const onNew = vi.fn(async () => undefined)
    render(<SessionPicker loadSessions={async () => SESSIONS} onResume={noop} onNew={onNew} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New conversation' })) })
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape closes and returns focus to the trigger; disabled blocks opening', async () => {
    const { rerender } = render(<SessionPicker loadSessions={async () => SESSIONS} onResume={noop} onNew={noop} />)
    trigger().focus()
    open()
    const search = screen.getByRole('textbox', { name: 'Search conversations' })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()))
    rerender(<SessionPicker loadSessions={async () => SESSIONS} onResume={noop} onNew={noop} disabled />)
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})
