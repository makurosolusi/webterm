/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import { ModePicker } from './modePicker'

afterEach(cleanup)
// jsdom lacks the pointer-capture and scroll APIs the Radix Select calls when it opens.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})

const trigger = () => screen.getByRole('combobox', { name: 'Permission mode' })
const choose = (label: string) => {
  fireEvent.keyDown(trigger(), { key: 'Enter' })
  fireEvent.click(screen.getByRole('option', { name: label }))
}

describe('ModePicker', () => {
  it('labels the current mode like Claude Code and lists every mode', () => {
    render(<ModePicker mode="manual" onChange={vi.fn(async () => undefined)} />)
    expect(trigger().textContent).toContain('Ask before edits')
    fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect(screen.getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Ask before edits', 'Edit automatically', 'Plan mode', 'Auto mode', 'Bypass permissions'])
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
    expect(trigger().textContent).toContain('Plan mode')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    reject(new Error('HTTP 409'))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not switch to Plan mode: HTTP 409')
    expect(trigger().textContent).toContain('Ask before edits')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onChange).toHaveBeenLastCalledWith('plan')
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('is disabled when asked', () => {
    render(<ModePicker mode="plan" onChange={vi.fn(async () => undefined)} disabled />)
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})
