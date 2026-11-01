import { describe, expect, it } from 'vitest'
import { allRows } from '../../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { applyProposal } from './applyProposal'
import { parseProposals } from './proposalParser'
import { validateProposal } from './proposalPolicy'

const goalInput = {
  projectId: 'p1', statement: 'Ship the slice',
  successCriteria: [{ kind: 'review', by: 'human' }], owner: 'human:root',
  horizon: '2026-11-30', envelope: { maxCostMicros: 1000, maxWallMs: 1000, maxItems: 2 },
}
const planInput = { projectId: 'p3', items: [{ title: 'Implement it', scope: ['src/server'] }] }

function fixture(): Fixture {
  const value = openFixture()
  seedPortfolio(value.db)
  return value
}

describe('proposalParser', () => {
  it('parses one and multiple valid blocks', () => {
    expect(parseProposals('<webterm-proposal>{"tool":"goal.propose","input":{}}</webterm-proposal>')).toHaveLength(1)
    expect(parseProposals([
      '<webterm-proposal>{"tool":"goal.propose","input":{}}</webterm-proposal>',
      '<webterm-proposal>{"tool":"plan.propose","input":{}}</webterm-proposal>',
    ].join('\n'))).toHaveLength(2)
  })
  it('ignores malformed, oversized, and prototype-polluting blocks', () => {
    const huge = 'x'.repeat(16 * 1024 + 1)
    const text = [
      '<webterm-proposal>{bad</webterm-proposal>',
      `<webterm-proposal>${huge}</webterm-proposal>`,
      '<webterm-proposal>{"tool":"goal.propose","input":{"__proto__":{}}}</webterm-proposal>',
    ].join('')
    expect(parseProposals(text)).toEqual([])
  })
  it('rejects non-object input', () => {
    expect(parseProposals('<webterm-proposal>{"tool":"goal.propose","input":[]}</webterm-proposal>')).toEqual([])
    expect(parseProposals('<webterm-proposal>{"tool":"goal.propose","input":null}</webterm-proposal>')).toEqual([])
  })
})

describe('proposalPolicy', () => {
  it('enforces planner and tool gates', () => {
    const f = fixture()
    const block = { tool: 'goal.propose', input: goalInput }
    expect(validateProposal(block, { db: f.db, conversationId: 'global', planner: false, toolsWrite: true }).code).toBe('planner_off')
    expect(validateProposal(block, { db: f.db, conversationId: 'global', planner: true, toolsWrite: false }).code).toBe('tools_read_only')
    f.close()
  })
  it('rejects unknown tools, forbidden nested keys, and invalid projects', () => {
    const f = fixture()
    const base = { db: f.db, conversationId: 'global', planner: true, toolsWrite: true }
    expect(validateProposal({ tool: 'x', input: goalInput }, base).code).toBe('unknown_tool')
    for (const key of ['actor', 'status', 'cwd']) {
      expect(validateProposal({ tool: 'goal.propose', input: { ...goalInput, envelope: { [key]: 'bad' } } }, base).code).toBe('forbidden_key')
    }
    expect(validateProposal({ tool: 'goal.propose', input: { ...goalInput, projectId: '' } }, base).code).toBe('project_required')
    expect(validateProposal({ tool: 'goal.propose', input: { ...goalInput, projectId: 'missing' } }, base).code).toBe('project_not_found')
    expect(validateProposal({ tool: 'goal.propose', input: goalInput }, { ...base, conversationId: 'central:project:p2' }).code).toBe('conversation_project_mismatch')
    f.close()
  })
  it('accepts valid goal and plan shapes', () => {
    const f = fixture()
    const policy = { db: f.db, conversationId: 'central:project:p1', planner: true, toolsWrite: true }
    expect(validateProposal({ tool: 'goal.propose', input: goalInput }, policy).ok).toBe(true)
    expect(validateProposal({ tool: 'plan.propose', input: planInput }, { ...policy, conversationId: 'central:project:p3' }).ok).toBe(true)
    f.close()
  })
  it('accepts task.assign and rejects invalid version, item, and actor', () => {
    const f = fixture()
    const base = { db: f.db, conversationId: 'central:project:p1', planner: true, toolsWrite: true }
    const valid = { projectId: 'p1', itemId: 'item-1', expectedVersion: 1, assignee: 'worker:p1' }
    expect(validateProposal({ tool: 'task.assign', input: valid }, base).ok).toBe(true)
    expect(validateProposal({ tool: 'task.assign', input: { ...valid, expectedVersion: 0 } }, base).code).toBe('invalid_shape')
    expect(validateProposal({ tool: 'task.assign', input: { ...valid, itemId: '' } }, base).code).toBe('invalid_shape')
    expect(validateProposal({ tool: 'task.assign', input: { ...valid, actor: 'central' } }, base).code).toBe('forbidden_key')
    f.close()
  })
})

describe('applyProposal', () => {
  it('creates goal and draft plan, and audits success and stale failure', async () => {
    const f = fixture()
    const goalInputForApply = { ...goalInput, projectId: 'p3' }
    const goal = await applyProposal(f.db, { tool: 'goal.propose', input: goalInputForApply, projectId: 'p3' })
    expect(goal).toMatchObject({ ok: true, goalVersion: 1 })
    expect(allRows(f.db, 'SELECT * FROM plan WHERE project_id = ?', 'p3')).toHaveLength(0)
    const plan = await applyProposal(f.db, { tool: 'plan.propose', input: planInput, projectId: 'p3' })
    expect(plan).toMatchObject({ ok: true, planVersion: 1 })
    const stale = await applyProposal(f.db, { tool: 'plan.propose', input: { ...planInput, expectedVersion: 9 }, projectId: 'p3' })
    expect(stale.ok).toBe(false)
    expect(allRows(f.db, 'SELECT version, status FROM plan WHERE project_id = ?', 'p3')[0]).toMatchObject({ version: 1, status: 'draft' })
    expect(allRows(f.db, "SELECT * FROM event WHERE kind = 'central.proposal'")).toHaveLength(3)
    f.close()
  })
})
