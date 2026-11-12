/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatApiError } from './agentChatTransport'
import { fakeAgentChatTransport, initEvent } from './agentChatTransport.fake'
import { AgentChatView, statusLabel } from './agentChatView'
import { initialAgentChatState } from './agentChatStore'

afterEach(cleanup)

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

  it('shows Stop while busy, Stop interrupts, and a send during a turn queues as next', async () => {
    const { emit, t } = setup()
    emit({ seq: 1, t: 'status', status: 'thinking' })
    expect(await screen.findByText('Thinking…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(t.interrupt).toHaveBeenCalledTimes(1)
    expect(box().disabled).toBe(false)
    fireEvent.change(box(), { target: { value: 'also this' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(t.send).toHaveBeenCalledWith('also this', 'next', [])
  })

  it('a turn stopped mid-stream keeps its text but is no longer marked streaming', async () => {
    const { emit } = setup()
    emit({ seq: 1, t: 'status', status: 'thinking' }, { seq: 2, t: 'delta', messageId: 'm1', kind: 'text', text: 'Let me look' })
    expect(await screen.findByText('streaming')).toBeTruthy()
    emit({ seq: 3, t: 'status', status: 'interrupted' })
    await waitFor(() => expect(screen.queryByText('streaming')).toBeNull())
    expect(screen.getByText('Let me look')).toBeTruthy()
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

  it('shows the reconnecting banner and the last cost', async () => {
    const { emit, status } = setup()
    emit({ seq: 1, t: 'result', costUsd: 0.5, durationMs: 1, isError: false, interrupted: false, denials: 0 })
    expect(await screen.findByText('$0.5000')).toBeTruthy()
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
