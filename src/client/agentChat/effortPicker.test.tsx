/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EffortPicker } from './effortPicker'

afterEach(cleanup)
// jsdom lacks the ResizeObserver / pointer-capture APIs the Radix popper menu calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

const trigger = () => screen.getByRole('button', { name: /^Effort and thinking/ })
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' })

describe('EffortPicker', () => {
  it('lists the model levels with the current one checked plus the thinking toggle', () => {
    render(<EffortPicker levels={['low', 'medium', 'high']} effort="medium" thinking onChange={vi.fn(async () => undefined)} />)
    expect(trigger().textContent).toBe('Medium')
    open()
    const radios = screen.getAllByRole('menuitemradio')
    expect(radios.map((r) => r.textContent)).toEqual(['Low', 'Medium', 'High'])
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Extended thinking' }).getAttribute('aria-checked')).toBe('true')
  })

  it('hides effort when the model has no levels, keeping thinking', () => {
    render(<EffortPicker levels={[]} thinking={false} onChange={vi.fn(async () => undefined)} />)
    expect(trigger().getAttribute('aria-label')).toBe('Effort and thinking: Extended thinking: off')
    open()
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByText('This model has no effort levels')).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Extended thinking' })).toBeTruthy()
  })

  it('shows no effort section and no hint while levels are unknown', () => {
    render(<EffortPicker thinking={false} onChange={vi.fn(async () => undefined)} />)
    open()
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.queryByText('This model has no effort levels')).toBeNull()
  })

  it('selecting a level sends { effort }; toggling thinking sends { thinking }', async () => {
    const onChange = vi.fn(async () => undefined)
    render(<EffortPicker levels={['low', 'high']} effort="low" thinking={false} onChange={onChange} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' })) })
    expect(onChange).toHaveBeenLastCalledWith({ effort: 'high' })
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Extended thinking' })) })
    expect(onChange).toHaveBeenLastCalledWith({ thinking: true })
  })

  it('shows the pending value, then reverts and offers Retry when the change fails', async () => {
    let reject: (e: Error) => void = () => undefined
    const onChange = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_r, j) => { reject = j }))
      .mockResolvedValueOnce(undefined)
    render(<EffortPicker levels={['low', 'high']} effort="low" thinking={false} onChange={onChange} />)
    open()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
    expect(screen.getByRole('status', { name: 'Applying change' })).toBeTruthy()
    expect(trigger().textContent).toBe('High')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    await act(async () => reject(new Error('unsupported')))
    expect(screen.getByRole('alert').textContent).toContain('Could not set effort High: unsupported')
    expect(trigger().textContent).toBe('Low')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onChange).toHaveBeenLastCalledWith({ effort: 'high' })
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
