/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ChatMessages from './chatMessages'
import { splitProposalBlocks } from './proposalBlocks'

const block = (value: unknown) => `<webterm-proposal>${JSON.stringify(value)}</webterm-proposal>`
afterEach(cleanup)

describe('splitProposalBlocks (legacy history)', () => {
  it('extracts a block and removes its raw tags from visible text', () => {
    const result = splitProposalBlocks(`Before\n${block({ tool: 'goal.propose', input: { projectId: 'p1' } })}\nAfter`)
    expect(result.visible).toBe('Before\n\nAfter')
    expect(result.proposals).toEqual([{ tool: 'goal.propose', body: '{"tool":"goal.propose","input":{"projectId":"p1"}}' }])
  })

  it('extracts multiple blocks in order', () => {
    const result = splitProposalBlocks(`${block({ tool: 'goal.propose', input: {} })} ${block({ tool: 'plan.propose', input: {} })}`)
    expect(result.proposals.map((proposal) => proposal.tool)).toEqual(['goal.propose', 'plan.propose'])
  })

  it('keeps malformed blocks visible', () => {
    const malformed = '<webterm-proposal>{bad</webterm-proposal>'
    const result = splitProposalBlocks(`Text ${malformed} ${block({ input: {} })}`)
    expect(result.proposals).toHaveLength(0)
    expect(result.visible).toContain(malformed)
    expect(result.visible).toContain('{"input":{}}')
  })
})

describe('legacy proposal in chat history', () => {
  it('renders as a collapsed, read-only block with no action button', () => {
    const text = `Plan below.\n${block({ tool: 'goal.propose', input: { projectId: 'p1', statement: 'Ship it' } })}`
    render(<ChatMessages streaming={false} messages={[{ id: 'a1', seq: 1, role: 'assistant', parts: [{ type: 'text', text }], state: 'complete' }]} />)
    const details = document.querySelector('details.chat-proposal__detail') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(screen.getByText('Legacy proposal · goal.propose (not run)')).toBeTruthy()
    expect(details.textContent).toContain('"statement":"Ship it"')
    expect(screen.getByText('Plan below.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('<webterm-proposal>')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
