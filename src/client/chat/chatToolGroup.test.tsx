/** @vitest-environment jsdom */
// A run of tool calls in the Central thread collapses into one "Used N tools" row; approvals stay visible.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatMessages from './chatMessages'
import type { ChatMessage, ChatPart, ChatToolState } from './chatTypes'

vi.mock('./chatApprovalCard', () => ({
  ChatApprovalCard: (p: { approvalId: string }) => <div data-testid="approval">{`approval ${p.approvalId}`}</div>,
}))

afterEach(cleanup)

const tool = (id: string, name: string, state: ChatToolState = 'succeeded'): ChatPart =>
  ({ type: 'tool', toolCallId: id, name, state, result: { ok: true } })
const msg = (id: string, parts: ChatPart[], role: ChatMessage['role'] = 'assistant'): ChatMessage =>
  ({ id, role, seq: 1, state: 'complete', parts })

const groups = (): HTMLDetailsElement[] => Array.from(document.querySelectorAll<HTMLDetailsElement>('details.chat-tool-group'))

describe('Central tool group', () => {
  it('collapses three tools into one "Used 3 tools" summary, cards hidden until clicked', () => {
    render(<ChatMessages streaming={false} messages={[msg('a', [tool('1', 'node_list'), tool('2', 'task_get'), tool('3', 'canvas_open'), { type: 'text', text: 'Done.' }])]} />)
    expect(groups()).toHaveLength(1)
    const summary = screen.getByText('Used 3 tools')
    const group = groups()[0]!
    expect(group.open).toBe(false)
    expect(group.querySelectorAll('.chat-tool')).toHaveLength(3)
    fireEvent.click(summary.closest('summary')!)
    expect(group.open).toBe(true)
    expect(screen.getByText('Done.')).toBeTruthy()
  })

  it('shows the failed count in the error tone', () => {
    render(<ChatMessages streaming={false} messages={[msg('a', [tool('1', 'node_list'), tool('2', 'canvas_close', 'failed')])]} />)
    expect(screen.getByText('Used 2 tools')).toBeTruthy()
    const failed = screen.getByText('· 1 failed')
    expect(failed.className).toBe('chat-tool-group__failed')
  })

  it('shows the running tool name with the busy indicator', () => {
    render(<ChatMessages streaming messages={[msg('a', [tool('1', 'node_list'), tool('2', 'task_get', 'running')])]} />)
    const label = screen.getByText('Running task_get…')
    expect(label.parentElement?.querySelector('.codicon-modifier-spin')).not.toBeNull()
    expect(screen.queryByText(/Used/)).toBeNull()
  })

  it('keeps an approval card visible outside the group', () => {
    render(<ChatMessages streaming messages={[msg('a', [tool('1', 'node_list'), tool('2', 'node_spawn', 'awaiting_approval'), { type: 'approval', approvalId: 'ap1', state: 'awaiting_approval' }])]} />)
    const approval = screen.getByTestId('approval')
    expect(approval.closest('details')).toBeNull()
    expect(groups()).toHaveLength(1)
  })

  it('text between tool runs splits them into two groups', () => {
    render(<ChatMessages streaming={false} messages={[msg('a', [tool('1', 'node_list'), { type: 'text', text: 'Looking.' }, tool('2', 'task_get'), tool('3', 'task_list')])]} />)
    expect(groups()).toHaveLength(2)
    expect(screen.getByText('Used 1 tool')).toBeTruthy()
    expect(screen.getByText('Used 2 tools')).toBeTruthy()
  })

  it('folds consecutive tool-only messages into the previous group until text arrives', () => {
    render(<ChatMessages streaming={false} messages={[
      msg('a', [tool('1', 'node_list')]),
      msg('t', [tool('2', 'task_get')], 'tool'),
      msg('b', [{ type: 'text', text: 'Answer.' }]),
    ]} />)
    expect(groups()).toHaveLength(1)
    expect(screen.getByText('Used 2 tools')).toBeTruthy()
    expect(screen.getAllByLabelText(/assistant message|tool message/)).toHaveLength(2)
  })

  it('renders text A, the tool group, then text B in DOM order as separate blocks', () => {
    const { container } = render(<ChatMessages streaming={false} messages={[msg('a', [
      { type: 'text', text: 'I will close it now.' }, tool('1', 'node_close'), tool('2', 'canvas_list', 'failed'),
      { type: 'text', text: 'Canvas is empty.' },
    ])]} />)
    const a = screen.getByText('I will close it now.')
    const b = screen.getByText('Canvas is empty.')
    const group = groups()[0]!
    const follows = (x: Node, y: Node) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(follows(a, group)).toBe(true)
    expect(follows(group, b)).toBe(true)
    expect(a).not.toBe(b)
    expect(container.textContent).not.toContain('now.Canvas')
  })
})
