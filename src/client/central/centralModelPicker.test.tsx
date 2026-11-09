/** @vitest-environment jsdom */
// The Central chat header's model picker: badge trigger, model + effort menu, every UI state.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CentralModelState } from './centralModel'
import { CentralModelPicker } from './centralModelPicker'

afterEach(cleanup)
// jsdom lacks the ResizeObserver / pointer-capture APIs the Radix popper menu calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

const CONV = 'central:global' // test-only
const OPUS: CentralModelState = { alias: 'opus', effort: 'high', tier: 'T3', pending: true, override: { model: 'opus', effort: 'high' } }
const AUTO: CentralModelState = { alias: 'sonnet', effort: 'medium', tier: 'T2', pending: false, override: null }
const trigger = () => screen.getByRole('button', { name: /^Model/ })
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' })
const radio = (name: string) => screen.getByRole('menuitemradio', { name })

function setup(state: CentralModelState, setModel = vi.fn(async () => state)) {
  const load = vi.fn(async () => state)
  const onModelSet = vi.fn()
  const view = render(<CentralModelPicker conversationId={CONV} refreshKey={0} load={load} setModel={setModel} onModelSet={onModelSet} />)
  const rerender = (props: { openRequest?: number; conversationId?: string }) =>
    view.rerender(<CentralModelPicker conversationId={props.conversationId ?? CONV} refreshKey={0} load={load} setModel={setModel} onModelSet={onModelSet} openRequest={props.openRequest} />)
  return { load, setModel, onModelSet, rerender }
}

describe('CentralModelPicker', () => {
  it('shows the badge text on the trigger, loading first', async () => {
    setup(OPUS)
    expect(trigger().textContent).toBe('Model…')
    expect(trigger().getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(trigger().textContent).toBe('opus · high · T3 · next session'))
  })

  it('a new openRequest opens the menu with the current choice checked', async () => {
    const { rerender } = setup(OPUS)
    await screen.findByText('opus · high · T3 · next session')
    rerender({ openRequest: 1 })
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(radio('Opus').getAttribute('aria-checked')).toBe('true')
    expect(radio('High').getAttribute('aria-checked')).toBe('true')
  })

  it('choosing a model keeps the effort; choosing an effort keeps the model; then the badge reloads', async () => {
    const { setModel, onModelSet } = setup(OPUS)
    await screen.findByText('opus · high · T3 · next session')
    open()
    fireEvent.click(radio('Sonnet'))
    await waitFor(() => expect(onModelSet).toHaveBeenCalledTimes(1))
    expect(setModel).toHaveBeenLastCalledWith(CONV, 'sonnet', 'high')
    open()
    fireEvent.click(radio('Low'))
    await waitFor(() => expect(onModelSet).toHaveBeenCalledTimes(2))
    expect(setModel).toHaveBeenLastCalledWith(CONV, 'opus', 'low') // the fake echoes OPUS back
  })

  it('effort is disabled while Auto is the choice', async () => {
    const { setModel } = setup(AUTO)
    await screen.findByText('sonnet · medium · T2')
    open()
    expect(radio('Auto (model ladder)').getAttribute('aria-checked')).toBe('true')
    expect(radio('Default').getAttribute('aria-checked')).toBe('true')
    for (const e of ['Default', 'Low', 'Max']) expect(radio(e).getAttribute('data-disabled')).not.toBeNull()
    fireEvent.click(radio('Haiku'))
    await waitFor(() => expect(setModel).toHaveBeenCalledWith(CONV, 'haiku', undefined))
  })

  it('a rejected change shows Retry and Dismiss, reverts, and Retry calls again', async () => {
    const setModel = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(OPUS)
    const { onModelSet } = setup(AUTO, setModel)
    await screen.findByText('sonnet · medium · T2')
    open()
    fireEvent.click(radio('Opus'))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not switch to Opus: HTTP 500')
    open()
    expect(radio('Auto (model ladder)').getAttribute('aria-checked')).toBe('true') // reverted
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onModelSet).toHaveBeenCalledTimes(1))
    expect(setModel).toHaveBeenCalledTimes(2)
    expect(setModel).toHaveBeenLastCalledWith(CONV, 'opus', undefined)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a load failure keeps the trigger and offers Retry in the menu', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('ledger off')).mockResolvedValueOnce(OPUS)
    const { rerender } = render(<CentralModelPicker conversationId={CONV} refreshKey={0} load={load} />)
    await waitFor(() => expect(trigger().textContent).toBe('Model'))
    rerender(<CentralModelPicker conversationId={CONV} refreshKey={0} load={load} openRequest={1} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the model: ledger off')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    await waitFor(() => expect(trigger().textContent).toBe('opus · high · T3 · next session'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a failed change does not follow the user to another conversation', async () => {
    const setModel = vi.fn(async () => { throw new Error('HTTP 500') })
    const { rerender } = setup(AUTO, setModel)
    await screen.findByText('sonnet · medium · T2')
    open()
    fireEvent.click(radio('Opus'))
    await screen.findByRole('alert')
    act(() => rerender({ conversationId: 'central:chat:other', openRequest: 0 }))
    expect(screen.queryByRole('alert')).toBeNull()
    await screen.findByText('sonnet · medium · T2')
  })
})
