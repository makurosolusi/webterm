/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatModel } from '../../shared/agentChat.wire'
import { ModelPicker } from './modelPicker'

afterEach(cleanup)
// jsdom lacks the ResizeObserver / pointer-capture APIs the Radix popper menu calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

const MODELS: AgentChatModel[] = [ // test-only
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus for complex work' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast everyday model', efforts: ['low', 'high'] },
]
const trigger = () => screen.getByRole('button', { name: /^Model:/ })
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' })
const deferred = () => {
  let resolve: () => void = () => undefined
  let reject: (e: Error) => void = () => undefined
  const promise = new Promise<void>((r, j) => { resolve = r; reject = j })
  return { promise, resolve, reject }
}

describe('ModelPicker', () => {
  it('loads on open and lists displayName + description with the current model checked', async () => {
    const loadModels = vi.fn(async () => MODELS)
    render(<ModelPicker loadModels={loadModels} value="sonnet" onChange={vi.fn(async () => undefined)} />)
    expect(loadModels).not.toHaveBeenCalled()
    expect(trigger().textContent).toContain('sonnet')
    open()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Loading models…')
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['Default (recommended)Opus for complex work', 'SonnetFast everyday model'])
    expect(items[1].getAttribute('aria-checked')).toBe('true')
    expect(trigger().textContent).toContain('Sonnet')
    expect(loadModels).toHaveBeenCalledTimes(1)
  })

  it('shows the load error with Retry and still names the current model', async () => {
    const loadModels = vi.fn().mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce(MODELS)
    render(<ModelPicker loadModels={loadModels} value="claude-x" onChange={vi.fn(async () => undefined)} />)
    open()
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load models: HTTP 502')
    expect(trigger().getAttribute('aria-label')).toBe('Model: claude-x')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(loadModels).toHaveBeenCalledTimes(2)
  })

  it('selecting calls onChange, shows pending, then reverts with the error and retries', async () => {
    const first = deferred()
    const onChange = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined)
    render(<ModelPicker loadModels={async () => MODELS} value="default" onChange={onChange} />)
    open()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Sonnet/ }))
    expect(onChange).toHaveBeenCalledWith('sonnet')
    expect(screen.getByRole('status', { name: 'Switching model' })).toBeTruthy()
    expect(trigger().textContent).toContain('Sonnet')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    await act(async () => first.reject(new Error('HTTP 409')))
    expect(screen.getByRole('alert').textContent).toContain('Could not switch to Sonnet: HTTP 409')
    expect(trigger().textContent).toContain('Default (recommended)')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onChange).toHaveBeenLastCalledWith('sonnet')
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('does not call onChange when re-picking the current model', async () => {
    const onChange = vi.fn(async () => undefined)
    render(<ModelPicker loadModels={async () => MODELS} value="sonnet" onChange={onChange} />)
    open()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Sonnet/ }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Escape closes the menu and returns focus to the trigger', async () => {
    render(<ModelPicker loadModels={async () => MODELS} value="sonnet" onChange={vi.fn(async () => undefined)} />)
    trigger().focus()
    open()
    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it('maps an unset model to the default entry and uses a known list without loading', () => {
    const loadModels = vi.fn(async () => MODELS)
    render(<ModelPicker loadModels={loadModels} models={MODELS} onChange={vi.fn(async () => undefined)} />)
    expect(trigger().getAttribute('aria-label')).toBe('Model: Default (recommended)')
    open()
    expect(screen.getAllByRole('menuitemradio')[0].getAttribute('aria-checked')).toBe('true')
    expect(loadModels).not.toHaveBeenCalled()
  })

  it('compact hides the label but keeps the accessible name; disabled blocks opening', () => {
    render(<ModelPicker loadModels={async () => MODELS} value="sonnet" onChange={vi.fn(async () => undefined)} compact disabled />)
    expect(trigger().textContent).toBe('')
    expect(trigger().getAttribute('aria-label')).toBe('Model: sonnet')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})
