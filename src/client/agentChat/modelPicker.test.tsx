/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatModel } from '../../shared/agentChat.wire'
import { AUTO_MODEL_LABEL, ModelPicker } from './modelPicker'

afterEach(cleanup)
// jsdom lacks the ResizeObserver / pointer-capture APIs the Radix popper menu calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

const MODELS: AgentChatModel[] = [ // test-only
  { value: 'default', displayName: 'Auto (ladder: Sonnet · medium)', description: 'Picked by the model ladder' },
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
    expect(items.map((i) => i.textContent)).toEqual(['Auto (ladder: Sonnet · medium)Picked by the model ladder', 'SonnetFast everyday model'])
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
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Sonnet/ }))
    expect(onChange).toHaveBeenCalledWith('sonnet')
    expect(screen.getByRole('status', { name: 'Switching model' })).toBeTruthy()
    expect(trigger().getAttribute('aria-label')).toBe('Model: Sonnet')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    await act(async () => first.reject(new Error('HTTP 409')))
    expect(screen.getByRole('alert').textContent).toContain('Could not switch to Sonnet: HTTP 409')
    expect(trigger().textContent).toContain('Auto (ladder: Sonnet · medium)')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onChange).toHaveBeenLastCalledWith('sonnet')
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('does not call onChange when re-picking the current model', async () => {
    const onChange = vi.fn(async () => undefined)
    render(<ModelPicker loadModels={async () => MODELS} value="sonnet" onChange={onChange} />)
    open()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Sonnet/ }))
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
    expect(trigger().getAttribute('aria-label')).toBe('Model: Auto (ladder: Sonnet · medium)')
    open()
    expect(screen.getAllByRole('menuitemradio')[0].getAttribute('aria-checked')).toBe('true')
    expect(loadModels).not.toHaveBeenCalled()
  })

  it('an unset model shows the server-resolved Auto entry (workspace override included); before a list, a generic Auto', () => {
    const { unmount } = render(<ModelPicker loadModels={vi.fn(async () => MODELS)} onChange={vi.fn(async () => undefined)} />)
    expect(trigger().getAttribute('aria-label')).toBe(`Model: ${AUTO_MODEL_LABEL}`)
    unmount()
    const withOverride = [{ value: 'default', displayName: 'Auto (workspace: Opus · high)' }, ...MODELS.slice(1)]
    const { unmount: u2 } = render(<ModelPicker loadModels={vi.fn(async () => withOverride)} models={withOverride} onChange={vi.fn(async () => undefined)} />)
    expect(trigger().getAttribute('aria-label')).toBe('Model: Auto (workspace: Opus · high)')
    u2()
    render(<ModelPicker loadModels={vi.fn(async () => MODELS)} models={MODELS} value="sonnet" onChange={vi.fn(async () => undefined)} />)
    expect(trigger().getAttribute('aria-label')).toBe('Model: Sonnet')
  })

  it('shows the model name as text, not an icon only; disabled blocks opening', () => {
    render(<ModelPicker loadModels={async () => MODELS} value="sonnet" onChange={vi.fn(async () => undefined)} disabled />)
    expect(trigger().textContent).toBe('sonnet')
    expect(trigger().querySelector('.codicon-hubot')).toBeNull()
    expect(trigger().getAttribute('aria-label')).toBe('Model: sonnet')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})
