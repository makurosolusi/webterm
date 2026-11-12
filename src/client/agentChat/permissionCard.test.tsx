/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import type { PermissionEvent, PermissionOutcome } from './agentChatCards.types'
import { DEFAULT_DENY_MESSAGE, PermissionCard } from './permissionCard'

afterEach(cleanup)

const input = { command: 'rm -rf build', description: 'Remove build dir' }
const req = (over: Partial<PermissionEvent> = {}): PermissionEvent =>
  ({ t: 'permission', requestId: 'r1', kind: 'tool', toolName: 'Bash', toolUseId: 'tu1', input, ...over })
const setup = (over: Partial<PermissionEvent> = {}, outcome: PermissionOutcome = 'open', answer = vi.fn(async (_a: AgentChatPermissionAnswer) => undefined)) => {
  render(<PermissionCard request={req(over)} outcome={outcome} answer={answer} />)
  return answer
}
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('PermissionCard', () => {
  it('shows the tool name and the shared summary', () => {
    setup()
    expect(screen.getByText('Allow Bash?')).toBeTruthy()
    expect(screen.getByText('Remove build dir')).toBeTruthy()
  })

  it('Allow once echoes the input as updatedInput', () => {
    const answer = setup()
    fireEvent.click(btn('Allow once'))
    expect(answer).toHaveBeenCalledWith({ requestId: 'r1', behavior: 'allow', updatedInput: input })
  })

  it('Always allow appears only with suggestions and sends always: true', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull()
    cleanup()
    const answer = setup({ suggestions: [{ type: 'addRules' }] })
    fireEvent.click(btn('Always allow'))
    expect(answer).toHaveBeenCalledWith({ requestId: 'r1', behavior: 'allow', updatedInput: input, always: true })
  })

  it('Deny sends the note, or a default message when empty', () => {
    const answer = setup()
    fireEvent.click(btn('Deny'))
    expect(answer).toHaveBeenLastCalledWith({ requestId: 'r1', behavior: 'deny', message: DEFAULT_DENY_MESSAGE })
    cleanup()
    const a2 = setup()
    fireEvent.change(screen.getByLabelText('Tell Claude what to do instead'), { target: { value: '  use make clean  ' } })
    fireEvent.click(btn('Deny'))
    expect(a2).toHaveBeenLastCalledWith({ requestId: 'r1', behavior: 'deny', message: 'use make clean' })
  })

  it('disables the buttons while pending, then shows the error and retries the same answer', async () => {
    let reject: (e: Error) => void = () => undefined
    const answer = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_r, j) => { reject = j }))
      .mockImplementationOnce(async () => undefined)
    setup({}, 'open', answer)
    fireEvent.click(btn('Allow once'))
    expect(btn('Allow once').disabled).toBe(true)
    expect(btn('Deny').disabled).toBe(true)
    expect(btn('Allow once').getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('.codicon-modifier-spin')).toBeTruthy()
    reject(new Error('HTTP 502'))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not send your answer: HTTP 502')
    expect(btn('Allow once').disabled).toBe(false)
    fireEvent.click(btn('Retry'))
    expect(answer).toHaveBeenCalledTimes(2)
    expect(answer.mock.calls[1][0]).toEqual(answer.mock.calls[0][0])
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it.each([['allow', 'Allowed'], ['deny', 'Denied'], ['cancelled', 'Cancelled'], ['expired', 'Expired']] as const)(
    'a resolved %s request is a read-only badge', (outcome, label) => {
      setup({}, outcome)
      expect(screen.getByRole('status').textContent).toBe(label)
      expect(screen.queryByRole('button')).toBeNull()
    })
})
