import { describe, expect, it } from 'vitest'
import { splitProposalBlocks } from './proposalBlocks'

const block = (value: unknown) => `<webterm-proposal>${JSON.stringify(value)}</webterm-proposal>`

describe('splitProposalBlocks', () => {
  it('extracts a proposal and removes its raw tags from visible text', () => {
    const result = splitProposalBlocks(`Before\n${block({ tool: 'goal.propose', input: { projectId: 'p1', itemId: 'g1' } })}\nAfter`)
    expect(result.visible).toBe('Before\n\nAfter')
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toMatchObject({ tool: 'goal.propose', projectId: 'p1', itemId: 'g1' })
    expect(result.visible).not.toContain('webterm-proposal')
  })

  it('extracts multiple proposals in order', () => {
    const result = splitProposalBlocks(`${block({ tool: 'goal.propose', input: {} })} ${block({ tool: 'plan.propose', input: {} })}`)
    expect(result.proposals.map((proposal) => proposal.tool)).toEqual(['goal.propose', 'plan.propose'])
  })

  it('keeps malformed blocks visible', () => {
    const malformed = '<webterm-proposal>{bad</webterm-proposal>'
    const result = splitProposalBlocks(`Text ${malformed}`)
    expect(result.proposals).toHaveLength(0)
    expect(result.visible).toContain(malformed)
  })

  it('only extracts string project and item identifiers', () => {
    const result = splitProposalBlocks(block({ tool: 'task.assign', input: { projectId: 'p2', itemId: 't4', goal: 'Ship' } }))
    expect(result.proposals[0]).toMatchObject({ projectId: 'p2', itemId: 't4' })
    expect(result.proposals[0].raw).toContain('task.assign')
  })
})
