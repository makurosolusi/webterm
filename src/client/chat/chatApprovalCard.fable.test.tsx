/** @vitest-environment jsdom */
// The Fable grant card: scope is a button, no typing; Deny is one click.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatApprovalCard } from './chatApprovalCard'
import { serveLedger } from './needsYou.fixtures'
import { resetNeedsYou, type UnifiedItem } from './needsYouApi'

beforeEach(() => {
  resetNeedsYou()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const FABLE: UnifiedItem = {
  id: 'fable_1', kind: 'gate', source: 'approval', approvalKind: 'model.fable', title: 'Allow Fable for this conversation?', body: null, args: null, count: 1,
  impact: { what: 'Fable is the highest-cost model. Without approval this runs on Opus', tier: 'R1', rewindable: true }, actions: ['approve', 'deny', 'ignore', 'snooze'],
}

describe('Fable grant card', () => {
  it('offers this conversation, the whole project, or deny: three buttons, no APPROVE phrase, no Always/Edit', async () => {
    serveLedger({ items: [FABLE] })
    render(<ChatApprovalCard approvalId="fable_1" partState="awaiting_approval" />)
    expect(await screen.findByRole('button', { name: 'Allow for this conversation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow for this project' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a node card says node', async () => {
    serveLedger({ items: [{ ...FABLE, nodeId: 'n1' }] })
    render(<ChatApprovalCard approvalId="fable_1" partState="awaiting_approval" />)
    expect(await screen.findByRole('button', { name: 'Allow for this node' })).toBeTruthy()
  })

  it.each([
    ['Allow for this conversation', { type: 'approve', scope: 'target' }],
    ['Allow for this project', { type: 'approve', scope: 'project' }],
    ['Deny', { type: 'deny' }],
  ])('%s posts the matching action', async (name, action) => {
    const ledger = serveLedger({ items: [FABLE] })
    render(<ChatApprovalCard approvalId="fable_1" partState="awaiting_approval" />)
    fireEvent.click(await screen.findByRole('button', { name }))
    await waitFor(() => expect(ledger.posts.at(-1)?.body).toMatchObject({ id: 'fable_1', action }))
  })
})
