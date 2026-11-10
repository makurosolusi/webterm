/** @vitest-environment jsdom */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import { AgentChatApiError } from './agentChatTransport'
import { fakeAgentChatTransport, initEvent } from './agentChatTransport.fake'
import { AgentChatView } from './agentChatView'
import { rateLimitText } from './rateLimitNotice'

afterEach(cleanup)
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 5_000 }) // full view in jsdom with rAF-batched events is slow under a loaded machine
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => undefined
})

function setup() {
  const f = fakeAgentChatTransport()
  render(<AgentChatView nodeId="n1" onNodeData={vi.fn()} transport={f.t} />)
  return f
}
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement
const userMsg = (seq: number, id: string, text: string): AgentChatEvent => ({ seq, t: 'message', messageId: id, role: 'user', parts: [{ k: 'text', text }] })
const conversation = (): AgentChatEvent[] => [
  initEvent(1, 's-1'), userMsg(2, 'u-1', 'first'), { seq: 3, t: 'message', messageId: 'a-1', role: 'assistant', parts: [{ k: 'text', text: 'one' }] },
  userMsg(4, 'u-2', 'second'), { seq: 5, t: 'status', status: 'idle' },
]
const rowOf = async (text: string): Promise<HTMLElement> => (await screen.findByText(text)).closest('.chat-message') as HTMLElement

describe('Rewind to here', () => {
  it('previews the files first, says what cannot be undone, then rewinds on confirm', async () => {
    const { t, emit } = setup()
    emit(...conversation())
    fireEvent.click(within(await rowOf('second')).getByRole('button', { name: 'Rewind files to here' }))
    expect(t.rewind).toHaveBeenCalledWith('u-2', true)
    const panel = await screen.findByRole('region', { name: 'Rewind files' })
    await waitFor(() => expect(within(panel).getByText('/w/a.ts')).toBeTruthy())
    expect(within(panel).getByText(/\+2 −1 lines/)).toBeTruthy()
    expect(within(panel).getByText(/Bash commands and from subagents are not undone/)).toBeTruthy()
    expect(t.rewind).toHaveBeenCalledTimes(1)
    fireEvent.click(within(panel).getByRole('button', { name: 'Rewind files' }))
    await waitFor(() => expect(within(panel).getByText('Rewound 1 file.')).toBeTruthy())
    expect(t.rewind).toHaveBeenLastCalledWith('u-2', false)
  })

  it('shows why when there is no checkpoint, and when the request fails', async () => {
    const { t, emit } = setup()
    emit(...conversation())
    t.rewind.mockResolvedValueOnce({ canRewind: false, error: 'No file checkpoint found for this message', filesChanged: [], insertions: 0, deletions: 0 })
    fireEvent.click(within(await rowOf('first')).getByRole('button', { name: 'Rewind files to here' }))
    expect(await screen.findByText('Cannot rewind: No file checkpoint found for this message')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rewind files' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close rewind' }))
    t.rewind.mockRejectedValueOnce(new AgentChatApiError('rewind', 'n1', 409, 'busy', 'Claude is working in this chat.'))
    fireEvent.click(within(await rowOf('first')).getByRole('button', { name: 'Rewind files to here' }))
    expect(await screen.findByText('Cannot rewind: Claude is working in this chat.')).toBeTruthy()
  })

  it('no Edit or Rewind while a turn runs', async () => {
    const { emit } = setup()
    emit(...conversation(), { seq: 6, t: 'status', status: 'thinking' })
    await screen.findByText('second')
    expect(screen.queryByRole('button', { name: 'Rewind files to here' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
  })
})

describe('Edit a sent message', () => {
  it('puts the text back in the composer; sending forks from that message instead of a plain send', async () => {
    const { t, emit } = setup()
    emit(...conversation())
    fireEvent.click(within(await rowOf('second')).getByRole('button', { name: 'Edit message' }))
    expect(box().value).toBe('second')
    expect(screen.getByRole('status', { name: 'Editing a message' })).toBeTruthy()
    fireEvent.change(box(), { target: { value: 'second, better' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(t.fork).toHaveBeenCalledWith('u-2', 'second, better', []))
    expect(t.send).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Editing a message' })).toBeNull())
  })

  it('Cancel leaves edit mode: the next message is a normal send', async () => {
    const { t, emit } = setup()
    emit(...conversation())
    fireEvent.click(within(await rowOf('first')).getByRole('button', { name: 'Edit message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(t.send).toHaveBeenCalledWith('first', undefined, []))
    expect(t.fork).not.toHaveBeenCalled()
  })

  it('a reset (the fork) reloads the timeline from the new transcript', async () => {
    const { t, emit } = setup()
    emit(...conversation())
    await waitFor(() => expect(t.history).toHaveBeenCalledTimes(1))
    emit({ seq: 6, t: 'reset', sessionId: 's-fork' })
    await waitFor(() => expect(t.history).toHaveBeenCalledTimes(2))
  })
})

describe('usage limit notice', () => {
  afterEach(() => vi.useRealTimers())

  it('shows one notice with the reset time and clears it when a turn succeeds', async () => {
    // test-only: local mid-day, so the reset an hour later stays on the same day ("at", not "on"). Mocks Date only; timers stay real for waitFor.
    vi.setSystemTime(new Date(2026, 10, 10, 12))
    const { emit } = setup()
    const at = Date.now() + 60 * 60_000
    emit(initEvent(1, 's-1'), { seq: 2, t: 'rateLimit', status: 'rejected', resetsAt: at, limit: 'five_hour' })
    const notice = await screen.findByRole('status', { name: 'Usage limit' })
    expect(notice.textContent).toContain('You have hit your 5-hour limit')
    expect(notice.textContent).toContain('It resets at')
    emit({ seq: 3, t: 'rateLimit', status: 'allowed_warning', resetsAt: at, limit: 'five_hour', utilization: 0.9 })
    await waitFor(() => expect(screen.getByRole('status', { name: 'Usage limit' }).textContent).toContain('close to your 5-hour limit (90% used)'))
    expect(screen.getAllByRole('status', { name: 'Usage limit' })).toHaveLength(1)
    emit({ seq: 4, t: 'result', costUsd: 0, durationMs: 1, isError: true, interrupted: false, denials: 0 }, { seq: 5, t: 'status', status: 'error' })
    await waitFor(() => expect(screen.getByText('Error')).toBeTruthy())
    expect(screen.queryByRole('status', { name: 'Usage limit' })).toBeTruthy()
    emit({ seq: 6, t: 'result', costUsd: 0, durationMs: 1, isError: false, interrupted: false, denials: 0 })
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Usage limit' })).toBeNull())
  })

  it('no reset time when none is given or it already passed', () => {
    expect(rateLimitText({ status: 'rejected' })).toBe('You have hit your usage limit. Claude cannot answer until it resets.')
    expect(rateLimitText({ status: 'rejected', resetsAt: 1 })).not.toContain('resets at')
  })
})

describe('Tasks list', () => {
  it('lists tasks with their progress, Stop calls stopTask, a failed stop says why', async () => {
    const { t, emit } = setup()
    emit(initEvent(1, 's-1'),
      { seq: 2, t: 'task', task: { id: 't1', status: 'running', description: 'Explore auth', summary: 'Reading login.ts' } },
      { seq: 3, t: 'task', task: { id: 't2', status: 'completed', description: 'Run tests' } })
    const panel = await screen.findByRole('region', { name: 'Tasks' })
    expect(within(panel).getByText('1 running')).toBeTruthy()
    expect(within(panel).getByText('Reading login.ts')).toBeTruthy()
    expect(within(panel).getByRole('img', { name: 'Completed' })).toBeTruthy()
    expect(within(panel).getAllByRole('button', { name: /Stop task/ })).toHaveLength(1)
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop task Explore auth' }))
    expect(t.stopTask).toHaveBeenCalledWith('t1')
    t.stopTask.mockRejectedValueOnce(new AgentChatApiError('stop task', 'n1', 409, 'not_running', 'This task is no longer running.'))
    await waitFor(() => expect((within(panel).getByRole('button', { name: 'Stop task Explore auth' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop task Explore auth' }))
    expect(await within(panel).findByText('Could not stop the task: This task is no longer running.')).toBeTruthy()
    emit({ seq: 4, t: 'task', task: { id: 't1', status: 'stopped', description: 'Explore auth' } })
    await waitFor(() => expect(within(panel).queryByRole('button', { name: /Stop task/ })).toBeNull())
  })
})
