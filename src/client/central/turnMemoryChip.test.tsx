/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatMessages from '../chat/chatMessages'
import type { ChatMessage } from '../chat/chatTypes'
import type { TurnContext } from './centralControlTypes'
import { TurnMemoryChip } from './turnMemoryChip'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// test-only
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 1, model: 'claude-sonnet' }
const reply = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', seq: 1, state: 'completed', parts: [{ type: 'text', text: 'hi' }], turnId: `turn-${id}`, usage, ...over }) as ChatMessage
const recorded: TurnContext = {
  memory: [{ id: 'm1', title: 'Uses bun', trust: 'human', status: 'fact' }, { id: 'm2', title: 'Maybe vite', trust: 'agent', status: 'claim' }],
  checkpointId: 'cp1', headerChars: 900, stateVersions: { global: 3, project: null },
}
const chip = () => screen.getByRole('button', { name: /Show what Central used/ })

describe('turn memory chip', () => {
  it('opens to the memories with trust labels, checkpoint and state versions, and shows the count', async () => {
    render(<TurnMemoryChip turnId="t1" load={vi.fn(async () => recorded)} />)
    fireEvent.click(chip())
    expect(await screen.findByText('Uses bun')).toBeTruthy()
    expect(screen.getByText('Confirmed by you')).toBeTruthy()
    expect(screen.getByText('From an agent, unverified')).toBeTruthy()
    expect(screen.getByText('Checkpoint: yes')).toBeTruthy()
    expect(screen.getByText('Working state: all projects v3, this project none')).toBeTruthy()
    expect(chip().textContent).toBe('Used 2 memories')
  })

  it('an old turn reads as not recorded', async () => {
    render(<TurnMemoryChip turnId="t1" load={vi.fn(async () => ({ memory: [], checkpointId: null, headerChars: null, stateVersions: null }))} />)
    fireEvent.click(chip())
    expect(await screen.findByText('This turn was not recorded.')).toBeTruthy()
  })

  it('a recorded turn with no memories says so and no checkpoint', async () => {
    render(<TurnMemoryChip turnId="t1" load={vi.fn(async () => ({ memory: [], checkpointId: null, headerChars: 10, stateVersions: null }))} />)
    fireEvent.click(chip())
    expect(await screen.findByText('No memories were used in this turn.')).toBeTruthy()
    expect(screen.getByText('Checkpoint: no')).toBeTruthy()
  })

  it('fetches once across reopenings, and again after a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(recorded)
    render(<TurnMemoryChip turnId="t1" load={load} />)
    fireEvent.click(chip())
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(chip())
    fireEvent.click(chip())
    await screen.findByText('Uses bun')
    expect(load).toHaveBeenCalledTimes(2)
    fireEvent.click(chip())
    fireEvent.click(chip())
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })
})

describe('policy: the chip costs no request until opened', () => {
  it('a thread of replies makes none; opening one chip makes exactly one, for that turn', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(recorded), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    render(<ChatMessages messages={[reply('a'), reply('b'), reply('c')]} streaming={false} />)
    const chips = screen.getAllByRole('button', { name: /Show what Central used/ })
    expect(chips).toHaveLength(3)
    expect(fetchSpy).not.toHaveBeenCalled()
    fireEvent.click(chips[1] as HTMLElement)
    await screen.findByText('Uses bun')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain('/api/central/turns/turn-b/context')
  })

  it('no chip on a reply still streaming or without a turn', () => {
    render(<ChatMessages messages={[reply('a', { state: 'streaming' }), reply('b', { turnId: undefined })]} streaming />)
    expect(screen.queryByRole('button', { name: /Show what Central used/ })).toBeNull()
  })
})
