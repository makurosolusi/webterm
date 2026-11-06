/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatTodo } from '../../shared/agentChat.wire'
import { initialAgentChatState, type AgentChatState, type ChatMessageView } from './agentChatStore'
import { AgentChatThread, type ThreadActions } from './agentChatThread'
import { messageText } from './messageActions'
import { TodoPanel } from './todoPanel'

const writeText = vi.fn(async (_: string) => {})
beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const actions: ThreadActions = { answer: vi.fn(), setMode: vi.fn(), loadFull: vi.fn(), imageUrl: (r) => r }
const msg = (id: string, role: 'user' | 'assistant', text: string, over: Partial<ChatMessageView> = {}): ChatMessageView =>
  ({ id, role, parts: text ? [{ k: 'text', text }] : [], draft: [], ...over })
const state = (over: Partial<AgentChatState>): AgentChatState => ({ ...initialAgentChatState('n1'), ...over })
const thread = (s: AgentChatState) => render(<AgentChatThread state={s} actions={actions} />)

describe('AgentChatThread timeline blocks', () => {
  it('renders command output (c:) with whitespace kept and a compact divider (k:)', () => {
    const text = 'Context usage\n  tokens:  12k / 200k'
    thread(state({
      order: ['c:o1', 'k:x1', 'k:x2'],
      commandOutputs: { o1: { text } },
      compacts: { x1: { trigger: 'manual', preTokens: 154321 }, x2: { trigger: 'auto' } },
    }))
    const out = screen.getByRole('region', { name: 'Command output' })
    expect(out.querySelector('pre')?.textContent).toBe(text)
    const dividers = screen.getAllByRole('separator')
    expect(dividers.map((d) => d.getAttribute('aria-label'))).toEqual([
      'Conversation compacted (manual · 154,321 tokens before)',
      'Conversation compacted (automatic)',
    ])
  })

  it('collapses long command output and toggles it', () => {
    thread(state({ order: ['c:o1'], commandOutputs: { o1: { text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') } } }))
    const region = screen.getByRole('region', { name: 'Command output' })
    expect(region.dataset.open).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(region.dataset.open).toBe('true')
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('ignores unknown key prefixes and dangling ids without crashing', () => {
    thread(state({ order: ['z:1', 'c:missing', 'k:missing', 'm:missing', 'weird', 'm:a'], messages: { a: msg('a', 'assistant', 'still here') } }))
    expect(screen.getByText('still here')).toBeTruthy()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('shows the queued badge only while the user message is queued', () => {
    const s = state({ order: ['m:u'], messages: { u: msg('u', 'user', 'next please', { queued: true }) } })
    const { rerender } = thread(s)
    expect(screen.getByText('Queued — sends when Claude finishes')).toBeTruthy()
    rerender(<AgentChatThread state={{ ...s, messages: { u: { ...s.messages.u, queued: false } } }} actions={actions} />)
    expect(screen.queryByText('Queued — sends when Claude finishes')).toBeNull()
  })

  it('copies the markdown source of a message and shows feedback', async () => {
    vi.useFakeTimers()
    const parts = [{ k: 'text' as const, text: '# Title' }, { k: 'tool' as const, id: 't1' }, { k: 'text' as const, text: 'Use `x`.' }]
    thread(state({ order: ['m:u', 'm:a'], messages: { u: msg('u', 'user', 'hi'), a: msg('a', 'assistant', '', { parts }) } }))
    const buttons = screen.getAllByRole('button', { name: 'Copy message' })
    expect(buttons).toHaveLength(2)
    await act(async () => { fireEvent.click(buttons[1]) })
    expect(writeText).toHaveBeenCalledWith('# Title\n\nUse `x`.')
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1600) })
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('reports a failed copy instead of claiming success', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    document.execCommand = vi.fn(() => false)
    thread(state({ order: ['m:u'], messages: { u: msg('u', 'user', 'hi') } }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy message' })) })
    expect(screen.getByText('Copy failed')).toBeTruthy()
  })

  it('offers no copy action for messages without text or while streaming', () => {
    thread(state({
      status: 'thinking',
      order: ['m:a', 'm:b'],
      messages: { a: msg('a', 'assistant', ''), b: msg('b', 'assistant', 'partial', { draft: [{ kind: 'text', text: 'more' }] }) },
    }))
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
    expect(messageText(msg('x', 'assistant', 'only'))).toBe('only')
  })

  it('copies command output', async () => {
    thread(state({ order: ['c:o1'], commandOutputs: { o1: { text: 'cost: $0.01' } } }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy command output' })) })
    expect(writeText).toHaveBeenCalledWith('cost: $0.01')
  })
})

describe('TodoPanel', () => {
  const todos: AgentChatTodo[] = [
    { content: 'Write tests', status: 'completed' },
    { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
    { content: 'Ship', status: 'pending' },
  ]

  it('is hidden when there are no todos', () => {
    const { container } = render(<TodoPanel todos={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows progress and per-item states', () => {
    render(<TodoPanel todos={todos} />)
    expect(screen.getByLabelText('1 of 3 done').textContent).toBe('1/3')
    const items = [...screen.getByRole('region', { name: 'Todo list' }).querySelectorAll('li')]
    expect(items.map((li) => [li.dataset.status, li.textContent])).toEqual([
      ['completed', 'Write tests'], ['in_progress', 'Fixing bug'], ['pending', 'Ship'],
    ])
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual(['Completed', 'In progress', 'Pending'])
  })

  it('collapses to the header with the current item', () => {
    render(<TodoPanel todos={todos} />)
    const head = screen.getByRole('button', { expanded: true })
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(head.textContent).toContain('Fixing bug')
  })
})
