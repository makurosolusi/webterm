/** @vitest-environment jsdom */
// The Central chat's model surface: `/model` reaches the server seam and the per-turn cost chip
// (the header picker is in centralModelPicker.test).
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CentralModelState } from './centralModel'
import { useCentralChatCommands } from './centralChatCommands'
import { ChatCostChip, cacheShare } from '../chat/chatCostChip'
import { applyChatEvent } from '../chat/chatEventReducer'
import { initialChatState } from '../chat/chatStore'
import { normalizeMessage } from '../chat/chatWire'

afterEach(cleanup)

const STATE: CentralModelState = { alias: 'opus', effort: 'high', tier: 'T3', pending: true, override: { model: 'opus', effort: 'high' } }

describe('/model', () => {
  it('sends the choice to the conversation and reloads the badge; a usage hint sends nothing', async () => {
    const setModel = vi.fn(async () => STATE)
    const send = vi.fn()
    const notice = vi.fn()
    const onSet = vi.fn()
    const { result } = renderHook(() => useCentralChatCommands({ centralEnabled: false, newChat: vi.fn(), showHistory: vi.fn(), setModel }, send, notice, 'central:global', onSet))
    act(() => result.current.onSend('/model opus high'))
    await waitFor(() => expect(onSet).toHaveBeenCalled())
    expect(setModel).toHaveBeenCalledWith('central:global', 'opus', 'high')
    act(() => result.current.onSend('/model gpt'))
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/^Usage: \/model/))
    expect(send).not.toHaveBeenCalled()
    expect(setModel).toHaveBeenCalledTimes(1)
  })

  it('shows a server refusal as the chat error', async () => {
    const setModel = vi.fn(async () => { throw new Error('model must be one of haiku, sonnet') })
    const notice = vi.fn()
    const { result } = renderHook(() => useCentralChatCommands({ centralEnabled: false, newChat: vi.fn(), showHistory: vi.fn(), setModel }, vi.fn(), notice, 'central:global'))
    act(() => result.current.onSend('/model sonnet'))
    await waitFor(() => expect(notice).toHaveBeenCalled())
  })
})

describe('per-turn cost chip', () => {
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, costMicros: 12_345, model: 'claude-sonnet-5-5', tier: 'T2', effort: 'medium' }

  it('renders model alias, tier and cost, with the cache share on hover', () => {
    render(<ChatCostChip usage={usage} />)
    const chip = screen.getByText('sonnet · T2 · $0.01')
    expect(chip.getAttribute('title')).toBe('80% of input from cache · 1.0k in / 50 out · medium effort')
    expect(cacheShare({ ...usage, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0)
  })

  it('reaches the reply from history and from the done frame', () => {
    expect(normalizeMessage({ id: 'a1', seq: 2, role: 'assistant', parts: [], usage })?.usage).toMatchObject({ tier: 'T2', costMicros: 12_345 })
    const streaming = { ...initialChatState('central:global'), messages: [{ id: 'a1', role: 'assistant' as const, seq: 2, state: 'streaming' as const, parts: [] }] }
    const next = applyChatEvent(streaming, { seq: 5, type: 'done', conversationId: 'central:global', messageId: 'a1', turnId: 't1', payload: { usage }, createdAt: 0 })
    expect(next.messages[0]).toMatchObject({ state: 'complete', usage: { model: 'claude-sonnet-5-5', tier: 'T2' } })
  })
})
