/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatModel } from '../../shared/agentChat.wire'
import { AgentChatHistory, AgentChatToolbar, type AgentChatToolbarProps } from './agentChatToolbar'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})
afterEach(cleanup)
const MODELS: AgentChatModel[] = [ // test-only
  { value: 'default', displayName: 'Auto (ladder: Sonnet · medium)', efforts: ['low', 'high'] },
  { value: 'haiku', displayName: 'Haiku' },
]
function mount(over: Partial<AgentChatToolbarProps> = {}) {
  const props: AgentChatToolbarProps = {
    modePicker: <span>MODE</span>,
    config: { thinking: false },
    context: { used: 100, window: 1000 },
    costUsd: 0.01234,
    tokens: { input: 1200, output: 34 },
    loadModels: vi.fn(async () => MODELS),
    onConfigChange: vi.fn(async () => undefined),
    loadSessions: vi.fn(async () => []),
    onResumeSession: vi.fn(async () => undefined),
    onNewSession: vi.fn(async () => undefined),
    ...over,
  }
  return { props, ...render(<div data-testid="row"><AgentChatToolbar {...props} /><AgentChatHistory {...props} /></div>) }
}
const row = () => screen.getByTestId('row')
const modelTrigger = () => screen.getByRole('button', { name: /^Model:/ })
const effortTrigger = () => screen.getByRole('button', { name: /^Effort and thinking/ })

describe('AgentChatToolbar', () => {
  it('composes mode slot, model name as text, effort and meter; cost and tokens only in the meter tooltip', async () => {
    mount()
    expect(row().textContent).toContain('MODE')
    expect(await screen.findByText('Auto (ladder: Sonnet · medium)')).toBeTruthy() // unset model = the ladder's default label
    expect(modelTrigger().textContent).toContain('Auto (ladder: Sonnet · medium)')
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('10')
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toContain('Session cost $0.0123 · last turn 1,200 in · 34 out')
    expect(row().textContent).not.toContain('$0.0123')
    expect(screen.getByRole('button', { name: 'Conversation history' }).textContent).toBe('') // header icon button
  })

  it('prefetches models once even with an inline loader, and passes the current model levels to the effort picker', async () => {
    const loadModels = vi.fn(async () => MODELS)
    const { rerender, props } = mount({ loadModels })
    await vi.waitFor(() => expect(loadModels).toHaveBeenCalled())
    await act(async () => {}) // let the prefetch land (the unset-model label shows before it)
    rerender(<div data-testid="row"><AgentChatToolbar {...props} loadModels={() => loadModels()} /></div>)
    rerender(<div data-testid="row"><AgentChatToolbar {...props} loadModels={() => loadModels()} /></div>)
    expect(loadModels).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(effortTrigger(), { key: 'Enter' })
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Low', 'High'])
  })

  it('hides effort levels for a model without any', async () => {
    mount({ config: { model: 'haiku', thinking: true } })
    await screen.findByText('Haiku')
    fireEvent.keyDown(effortTrigger(), { key: 'Enter' })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Extended thinking' }).getAttribute('aria-checked')).toBe('true')
  })

  it('routes model and effort changes to onConfigChange as patches', async () => {
    const { props } = mount()
    await screen.findByText('Auto (ladder: Sonnet · medium)')
    fireEvent.keyDown(modelTrigger(), { key: 'Enter' })
    await act(async () => { fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Haiku' })) })
    expect(props.onConfigChange).toHaveBeenLastCalledWith({ model: 'haiku' })
    fireEvent.keyDown(effortTrigger(), { key: 'Enter' })
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' })) })
    expect(props.onConfigChange).toHaveBeenLastCalledWith({ effort: 'high' })
  })

  it('shows the effort compactly: the level word, thinking as the lit bulb', async () => {
    mount({ config: { effort: 'high', thinking: true } })
    await screen.findByText('Auto (ladder: Sonnet · medium)')
    expect(effortTrigger().textContent).toBe('High')
    expect(effortTrigger().querySelector('.codicon-lightbulb-sparkle')).not.toBeNull()
  })

  it('disabled disables the model, effort and history triggers', () => {
    mount({ disabled: true })
    for (const b of [modelTrigger(), effortTrigger(), screen.getByRole('button', { name: 'Conversation history' })]) {
      expect((b as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
