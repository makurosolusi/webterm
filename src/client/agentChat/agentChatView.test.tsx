/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentChatApiError } from './agentChatTransport'
import { fakeAgentChatTransport, initEvent } from './agentChatTransport.fake'
import { AgentChatView, statusLabel } from './agentChatView'
import { initialAgentChatState } from './agentChatStore'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const setup = (props: { chatSessionId?: string } = {}) => {
  const f = fakeAgentChatTransport()
  const onNodeData = vi.fn()
  const view = render(<AgentChatView nodeId="n1" onNodeData={onNodeData} transport={f.t} {...props} />)
  return { ...f, onNodeData, view }
}
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement

describe('AgentChatView', () => {
  it('shows the empty state, then renders streamed text', async () => {
    const { emit } = setup()
    emit()
    expect(await screen.findByText('Ask Claude anything about this folder.')).toBeTruthy()
    emit({ seq: 1, t: 'delta', messageId: 'm1', kind: 'text', text: 'Hello ' }, { seq: 2, t: 'delta', messageId: 'm1', kind: 'text', text: 'world' })
    expect(await screen.findByText('Hello world')).toBeTruthy()
  })

  it('writes chatSessionId and the node mode from init into node data', async () => {
    const { emit, onNodeData } = setup()
    emit(initEvent(1, 'sess-9'))
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ chatSessionId: 'sess-9' }))
    expect(onNodeData).toHaveBeenCalledWith({ permissionMode: 'manual' })
  })

  it('does not rewrite a session id the node already has', async () => {
    const { emit, onNodeData } = setup({ chatSessionId: 'sess-9' })
    emit(initEvent(1, 'sess-9', { mode: 'plan' }))
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ permissionMode: 'plan' }))
    expect(onNodeData).not.toHaveBeenCalledWith({ chatSessionId: 'sess-9' })
  })

  it('answering a permission card calls the transport', async () => {
    const { emit, t } = setup()
    emit({ seq: 1, t: 'permission', requestId: 'r1', kind: 'tool', toolName: 'Bash', toolUseId: 'tu1', input: { command: 'ls' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(t.answer).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1', behavior: 'allow' })))
  })

  it('while busy shows "Thinking…" and Stop replaces Send; typing brings Send back to queue the message next', async () => {
    const { emit, t } = setup()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop turn' })).toBeNull()
    emit({ seq: 1, t: 'status', status: 'thinking' })
    expect(await screen.findByText('Thinking…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }))
    expect(t.interrupt).toHaveBeenCalledTimes(1)
    expect(box().disabled).toBe(false)
    fireEvent.change(box(), { target: { value: 'also this' } })
    expect(screen.getByRole('button', { name: 'Stop turn' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(t.send).toHaveBeenCalledWith('also this', 'next', [])
  })

  it('shows "Sending…" in the status line while a send is in flight', async () => {
    const { t } = setup()
    t.send.mockImplementationOnce(() => new Promise<undefined>(() => {}))
    fireEvent.change(box(), { target: { value: 'hi' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Sending…')).toBeTruthy()
  })

  it('puts the controls inside the composer box and ends the message list before the composer', async () => {
    const { emit, view } = setup()
    emit({ seq: 1, t: 'delta', messageId: 'm1', kind: 'text', text: 'last line' })
    await screen.findByText('last line')
    const composerBox = view.container.querySelector('.chat-composer__box')!
    const row = within(composerBox as HTMLElement).getByRole('toolbar', { name: 'Composer controls' })
    for (const name of [/^Permission mode/, /^Model:/, /^Effort and thinking/, /^Send message/]) expect(within(row).getByRole('button', { name })).toBeTruthy()
    expect(view.container.querySelector('footer')).toBeNull()
    const list = screen.getByRole('log')
    const composer = view.container.querySelector('.chat-composer')!
    expect(list.contains(composer)).toBe(false)
    expect(composer.contains(list)).toBe(false)
    expect(list.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Both are flex siblings in the column: the scrolling list (in its wrap) and the composer after it.
    expect(list.parentElement!.parentElement).toBe(composer.parentElement)
    expect(list.contains(screen.getByText('last line'))).toBe(true)
  })

  it('renders a reply without a "Claude" header and a notice as one compact line', async () => {
    const { emit } = setup()
    emit({ seq: 1, t: 'delta', messageId: 'm1', kind: 'text', text: 'Hi there' }, { seq: 2, t: 'notice', level: 'info', text: 'Session resumed' })
    const reply = (await screen.findByText('Hi there')).closest('.chat-message')!
    expect(reply.querySelector('.chat-message__meta')).toBeNull()
    expect(within(reply as HTMLElement).queryByText('Claude')).toBeNull()
    const notice = (await screen.findByText('Session resumed')).closest('.chat-notice')!
    expect(notice.className).toBe('chat-notice chat-notice--info')
    expect(notice.querySelector('.codicon')).toBeNull()
  })

  it('a turn stopped mid-stream keeps its text but is no longer marked streaming', async () => {
    const { emit } = setup()
    emit({ seq: 1, t: 'status', status: 'thinking' }, { seq: 2, t: 'delta', messageId: 'm1', kind: 'text', text: 'Let me look' })
    const row = () => screen.getByText('Let me look').closest('.chat-message')!
    await waitFor(() => expect(row().getAttribute('data-state')).toBe('streaming'))
    emit({ seq: 3, t: 'status', status: 'interrupted' })
    await waitFor(() => expect(row().getAttribute('data-state')).toBe('complete'))
  })

  it('a stream the server keeps refusing shows why with Retry, not "Connecting" forever', async () => {
    const { t } = setup()
    expect(screen.getByText('Connecting to Claude…')).toBeTruthy()
    act(() => t.stream.mock.calls[0]![0].onRefused?.(403))
    expect(await screen.findByText(/^Could not connect to Claude: the server refused this page \(403\)/)).toBeTruthy()
    expect(screen.queryByText('Connecting to Claude…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(t.stream).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Could not connect to Claude/)).toBeNull()
    expect(screen.getByText('Connecting to Claude…')).toBeTruthy()
  })

  it('keeps a failed message in a sticky error with Retry', async () => {
    const { t } = setup()
    t.send.mockRejectedValueOnce(new AgentChatApiError('send', 'n1', 409, 'session_locked', 'Open elsewhere.'))
    fireEvent.change(box(), { target: { value: 'hello' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Not sent: Open elsewhere.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(t.send).toHaveBeenLastCalledWith('hello', undefined, [])
    await waitFor(() => expect(screen.queryByText('Not sent: Open elsewhere.')).toBeNull())
  })

  it('shows the reconnecting banner, and the last cost only in the context meter tooltip', async () => {
    const { emit, status } = setup()
    emit({ seq: 1, t: 'result', costUsd: 0.5, durationMs: 1, isError: false, interrupted: false, denials: 0 }, { seq: 2, t: 'context', context: { used: 10, window: 100 } })
    await waitFor(() => expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toContain('Session cost $0.5000'))
    expect(screen.queryByText('$0.5000')).toBeNull()
    status('reconnecting')
    expect(screen.getByText('Connection lost. Reconnecting…')).toBeTruthy()
  })

  it('a node not saved yet shows connecting, not an error, and loads history once the stream opens', async () => {
    const { t, status } = setup()
    status('reconnecting') // the first stream attempt got 404: the board has not saved the node yet
    expect(screen.getByText('Connecting to Claude…')).toBeTruthy()
    expect(screen.queryByText('Connection lost. Reconnecting…')).toBeNull()
    expect(t.history).not.toHaveBeenCalled()
    status('open')
    await waitFor(() => expect(t.history).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Ask Claude anything about this folder.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the stream on unmount', () => {
    const { view, close, t } = setup()
    expect(t.stream).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('statusLabel', () => {
  it('labels connecting, retry and error states', () => {
    const s = initialAgentChatState('n')
    expect(statusLabel(s, 'connecting')).toBe('Connecting…')
    expect(statusLabel({ ...s, lastSeq: 1, status: 'retry', statusDetail: 'attempt 2' }, 'open')).toBe('Retrying: attempt 2')
    expect(statusLabel({ ...s, status: 'awaiting' }, 'open')).toBe('Waiting for you')
    expect(statusLabel({ ...s, status: 'error' }, 'open')).toBe('Error')
    expect(statusLabel(s, 'open')).toBeNull()
  })
})
