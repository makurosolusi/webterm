/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionEvent, PermissionOutcome } from './agentChatCards.types'
import { KEEP_PLANNING_MESSAGE, PlanCard } from './planCard'

afterEach(cleanup)

const input = { plan: '# Plan\n\n1. Do the thing' }
const req: PermissionEvent = { t: 'permission', requestId: 'p1', kind: 'plan', toolName: 'ExitPlanMode', toolUseId: 'tu3', input }
type Fn = (x: unknown) => Promise<void>
const setup = (outcome: PermissionOutcome = 'open', answer: Fn = vi.fn(async () => undefined), setMode: Fn = vi.fn(async () => undefined)) => {
  const calls: string[] = []
  const a = vi.fn(async (x: unknown) => { calls.push('answer'); return answer(x) })
  const m = vi.fn(async (x: unknown) => { calls.push('setMode'); return setMode(x) })
  render(<PlanCard request={req} outcome={outcome} answer={a} setMode={m} />)
  return { answer: a, setMode: m, calls }
}
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('PlanCard', () => {
  it('renders the plan as Markdown', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy()
    expect(screen.getByText('Do the thing')).toBeTruthy()
  })

  it('Approve answers allow, then sets the chosen next mode', async () => {
    const { answer, setMode, calls } = setup()
    fireEvent.click(screen.getByLabelText('Yes, and manually approve edits'))
    fireEvent.click(btn('Approve'))
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledWith('manual'))
    expect(answer).toHaveBeenCalledWith({ requestId: 'p1', behavior: 'allow', updatedInput: input })
    expect(calls).toEqual(['answer', 'setMode'])
  })

  it('defaults the next mode to auto-accept edits', async () => {
    const { setMode } = setup()
    fireEvent.click(btn('Approve'))
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledWith('acceptEdits'))
  })

  it('Keep planning denies with the feedback, or a default message', async () => {
    const { answer } = setup()
    fireEvent.change(screen.getByLabelText('Feedback on the plan'), { target: { value: 'Add tests first' } })
    fireEvent.click(btn('Keep planning'))
    expect(answer).toHaveBeenCalledWith({ requestId: 'p1', behavior: 'deny', message: 'Add tests first' })
    cleanup()
    const second = setup()
    fireEvent.click(btn('Keep planning'))
    expect(second.answer).toHaveBeenCalledWith({ requestId: 'p1', behavior: 'deny', message: KEEP_PLANNING_MESSAGE })
  })

  it('a failed setMode retries only the mode, never the settled answer', async () => {
    const setMode = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(undefined)
    const { answer } = setup('open', undefined, setMode)
    fireEvent.click(btn('Approve'))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 500')
    fireEvent.click(btn('Retry'))
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledTimes(2))
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('a failed answer keeps the buttons and retries the whole approval', async () => {
    const answer = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    const { setMode } = setup('open', answer)
    fireEvent.click(btn('Approve'))
    expect((await screen.findByRole('alert')).textContent).toContain('offline')
    expect(setMode).not.toHaveBeenCalled()
    fireEvent.click(btn('Retry'))
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledWith('acceptEdits'))
    expect(answer).toHaveBeenCalledTimes(2)
  })

  it('a resolved plan is read-only with a badge', () => {
    setup('deny')
    expect(screen.getByRole('status').textContent).toBe('Denied')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})
