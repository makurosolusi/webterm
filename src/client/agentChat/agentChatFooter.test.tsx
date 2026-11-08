/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatModel } from '../../shared/agentChat.wire'
import { AgentChatFooter, FOOTER_COMPACT_PX, type AgentChatFooterProps } from './agentChatFooter'

// jsdom has no layout: a ResizeObserver stand-in whose callbacks the test fires with a width.
const observers: ResizeObserverCallback[] = []
const g = globalThis as { ResizeObserver?: unknown }
const saved = g.ResizeObserver
beforeAll(() => {
  g.ResizeObserver = class { constructor(cb: ResizeObserverCallback) { observers.push(cb) } observe() {} unobserve() {} disconnect() {} }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})
afterAll(() => { g.ResizeObserver = saved })
afterEach(() => { cleanup(); observers.length = 0 })

const resize = (width: number) => act(() => {
  observers.forEach((cb) => cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver))
})
const MODELS: AgentChatModel[] = [ // test-only
  { value: 'default', displayName: 'Auto (ladder: Sonnet · medium)', efforts: ['low', 'high'] },
  { value: 'haiku', displayName: 'Haiku' },
]
function mount(over: Partial<AgentChatFooterProps> = {}) {
  const props: AgentChatFooterProps = {
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
  return { props, ...render(<AgentChatFooter {...props} />) }
}
const footer = () => document.querySelector('footer')!
const modelTrigger = () => screen.getByRole('button', { name: /^Model:/ })
const effortTrigger = () => screen.getByRole('button', { name: /^Effort and thinking/ })

describe('AgentChatFooter', () => {
  it('composes mode slot, pickers, meter, cost and tokens in a wide footer', async () => {
    mount()
    expect(footer().textContent).toContain('MODE')
    expect(await screen.findByText('Auto (ladder: Sonnet · medium)')).toBeTruthy() // unset model = the ladder's default label
    expect(screen.getByRole('button', { name: 'Conversation history' }).textContent).toBe('History')
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('10')
    expect(footer().textContent).toContain('$0.0123')
    expect(footer().textContent).toContain('1,200 in · 34 out')
  })

  it('prefetches models once even with an inline loader, and passes the current model levels to the effort picker', async () => {
    const loadModels = vi.fn(async () => MODELS)
    const { rerender, props } = mount({ loadModels })
    await vi.waitFor(() => expect(loadModels).toHaveBeenCalled())
    await act(async () => {}) // let the prefetch land (the unset-model label shows before it)
    rerender(<AgentChatFooter {...props} loadModels={() => loadModels()} />)
    rerender(<AgentChatFooter {...props} loadModels={() => loadModels()} />)
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

  it('collapses labels to icons and hides the token count when narrow, and restores them when wide', async () => {
    mount()
    await screen.findByText('Auto (ladder: Sonnet · medium)')
    resize(FOOTER_COMPACT_PX - 1)
    expect(footer().dataset.compact).toBe('true')
    expect(modelTrigger().textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Conversation history' }).textContent).toBe('')
    expect(screen.getByRole('meter').textContent).toBe('')
    expect(footer().textContent).not.toContain('34 out')
    expect(footer().textContent).toContain('$0.0123')
    resize(FOOTER_COMPACT_PX + 100)
    expect(footer().dataset.compact).toBeUndefined()
    expect(modelTrigger().textContent).toContain('Auto (ladder: Sonnet · medium)')
  })

  it('disabled disables the model, effort and history triggers', () => {
    mount({ disabled: true })
    for (const b of [modelTrigger(), effortTrigger(), screen.getByRole('button', { name: 'Conversation history' })]) {
      expect((b as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
