import { describe, expect, it } from 'vitest'
import { toReceipt } from './toolExec'

describe('toReceipt outcome', () => {
  it('a policy refusal is a denial, not an error', () => {
    expect(toReceipt({ ok: false, code: 'policy_denied', tool: 'goal.propose' }, 7)).toMatchObject({ outcome: 'denied', detail: 'policy_denied', evidence: { auditSeq: 7 } })
    expect(toReceipt({ ok: false, code: 'level_denied', tool: 'x' }, 1).outcome).toBe('denied')
    expect(toReceipt({ ok: false, code: 'tool_failed', tool: 'x' }, 1).outcome).toBe('error')
    expect(toReceipt({ ok: false, code: 'approval_expired', tool: 'agent.spawn' }, 1)).toMatchObject({ outcome: 'denied', detail: 'approval_expired', next: 'the approval card expired unanswered and the agent was cancelled; tell the human, and spawn again with a new requestId only if it is still wanted' })
  })
})
