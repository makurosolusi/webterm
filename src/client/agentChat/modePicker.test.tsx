/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import { ModePicker } from './modePicker'

afterEach(cleanup)
// jsdom lacks the ResizeObserver, pointer-capture and scroll APIs the Radix menu calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})

const trigger = () => screen.getByRole('button', { name: /^Permission mode/ })
const choose = (label: string) => {
  fireEvent.keyDown(trigger(), { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }))
}

describe('ModePicker', () => {
  it('is a compact chip (short word, full label as its name) whose menu lists every mode like Claude Code', () => {
    render(<ModePicker mode="manual" onChange={vi.fn(async () => undefined)} />)
    expect(trigger().textContent).toBe('Ask')
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Ask before edits')
    expect(screen.queryByRole('combobox')).toBeNull() // no boxed select
    fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent))
      .toEqual(['Ask before edits', 'Edit automatically', 'Plan mode', 'Auto mode', 'Bypass permissions'])
  })

  it('marks Bypass permissions as the danger mode', () => {
    const { container } = render(<ModePicker mode="bypassPermissions" onChange={vi.fn(async () => undefined)} />)
    expect(trigger().textContent).toBe('Bypass')
    expect(container.querySelector('[data-mode="bypassPermissions"] .codicon-warning')).not.toBeNull()
  })

  it('calls onChange, shows pending, then the error with Retry', async () => {
    let reject: (e: Error) => void = () => undefined
    const onChange = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_r, j) => { reject = j }))
      .mockImplementationOnce(async () => undefined)
    render(<ModePicker mode="manual" onChange={onChange} />)
    choose('Plan mode')
    expect(onChange).toHaveBeenCalledWith<[AgentPermissionMode]>('plan')
    expect(screen.getByRole('status', { name: 'Changing mode' })).toBeTruthy()
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Plan mode')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    reject(new Error('HTTP 409'))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not switch to Plan mode: HTTP 409')
    expect(trigger().textContent).toBe('Ask')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onChange).toHaveBeenLastCalledWith('plan')
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('is disabled when asked', () => {
    render(<ModePicker mode="plan" onChange={vi.fn(async () => undefined)} disabled />)
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})
