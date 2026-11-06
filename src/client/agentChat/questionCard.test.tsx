/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import type { PermissionEvent, PermissionOutcome } from './agentChatCards.types'
import { QuestionCard } from './questionCard'
import { rec } from './toolCards'

afterEach(cleanup)

const opts = (...labels: string[]) => labels.map((label) => ({ label, description: `${label} desc` }))
const input = {
  questions: [
    { question: 'Which DB?', header: 'Database', multiSelect: false, options: opts('SQLite', 'Postgres') },
    { question: 'Which extras?', header: 'Extras', multiSelect: true, options: opts('Auth', 'Cache', 'Queue') },
  ],
}
const req: PermissionEvent = { t: 'permission', requestId: 'q1', kind: 'question', toolName: 'AskUserQuestion', toolUseId: 'tu9', input }
const setup = (outcome: PermissionOutcome = 'open', answer = vi.fn(async (_a: AgentChatPermissionAnswer) => undefined)) => {
  render(<QuestionCard request={req} outcome={outcome} answer={answer} />)
  return answer
}
const submit = () => screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement
const group = (q: string) => screen.getByRole('group', { name: new RegExp(q.replace('?', '\\?')) })
const pick = (q: string, label: string) =>
  fireEvent.click(within(group(q)).queryByRole('radio', { name: label }) ?? within(group(q)).getByRole('checkbox', { name: label }))

describe('QuestionCard', () => {
  it('renders every question with its options and an Other choice', () => {
    setup()
    expect(screen.getByText('Claude has some questions')).toBeTruthy()
    expect(within(group('Which DB?')).getAllByRole('radio')).toHaveLength(3)
    expect(within(group('Which extras?')).getAllByRole('checkbox')).toHaveLength(4)
  })

  it('keeps Submit disabled until every question is answered', () => {
    setup()
    expect(submit().disabled).toBe(true)
    pick('Which DB?', 'Postgres')
    expect(submit().disabled).toBe(true)
    pick('Which extras?', 'Cache')
    expect(submit().disabled).toBe(false)
  })

  it('sends answers keyed by question text, multi-select joined in option order with Other last', () => {
    const answer = setup()
    pick('Which DB?', 'SQLite')
    pick('Which extras?', 'Queue')
    pick('Which extras?', 'Auth')
    pick('Which extras?', 'Other')
    fireEvent.change(screen.getByLabelText('Other answer: Which extras?'), { target: { value: 'Search' } })
    fireEvent.click(submit())
    expect(answer).toHaveBeenCalledWith({
      requestId: 'q1', behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which DB?': 'SQLite', 'Which extras?': 'Auth, Queue, Search' } },
    })
  })

  it('single-select Other replaces the picked option and needs text', () => {
    const answer = setup()
    pick('Which DB?', 'SQLite')
    pick('Which DB?', 'Other')
    pick('Which extras?', 'Auth')
    expect(submit().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Other answer: Which DB?'), { target: { value: 'DuckDB' } })
    fireEvent.click(submit())
    expect(rec(rec(rec(answer.mock.calls[0][0]).updatedInput).answers)['Which DB?']).toBe('DuckDB')
  })

  it('shows a failed submit inline and retries it', async () => {
    const answer = vi.fn().mockRejectedValueOnce(new Error('not_pending')).mockResolvedValueOnce(undefined)
    setup('open', answer)
    pick('Which DB?', 'SQLite')
    pick('Which extras?', 'Auth')
    fireEvent.click(submit())
    expect((await screen.findByRole('alert')).textContent).toContain('not_pending')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(answer).toHaveBeenCalledTimes(2)
  })

  it('a resolved question shows its badge and no Submit', () => {
    setup('cancelled')
    expect(screen.getByRole('status').textContent).toBe('Cancelled')
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
  })
})
