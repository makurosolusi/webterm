/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentList from './AgentList'
import ApprovalCardR2, { ApprovalQueue } from './ApprovalCardR2'
import LevelPanel from './LevelPanel'
import MemoryView, { looksSecret } from './MemoryView'
import SkillReview from './SkillReview'
import { fakeClient, R2, R3 } from './centralFixtures.testutil'

afterEach(cleanup)

describe('LevelPanel', () => {
  it('shows level, budget left and reports status', async () => {
    const onStatus = vi.fn()
    render(<LevelPanel client={fakeClient()} onStatus={onStatus} />)
    expect((await screen.findByTestId('level-effective')).textContent).toBe('L2 propose')
    expect(await screen.findByText(/750 left/)).toBeTruthy()
    expect(screen.getByText(/18 left/)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Tokens' })).toBeTruthy()
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ model: { id: 'opencode/free', free: true } })))
  })

  it('halt needs confirmation and can be cancelled', async () => {
    const client = fakeClient()
    render(<LevelPanel client={client} />)
    await screen.findByTestId('level-effective')
    fireEvent.click(screen.getByRole('button', { name: /Halt central/ }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(client.halt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(client.halt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Halt central/ }))
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: ' stop ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm halt' }))
    await waitFor(() => expect(client.halt).toHaveBeenCalledWith('stop'))
    expect(await screen.findByText(/Central halted/)).toBeTruthy()
  })

  it('surfaces a load error as an alert', async () => {
    render(<LevelPanel client={fakeClient({ getControl: vi.fn(async () => { throw new TypeError('x') }) })} />)
    expect((await screen.findByText('Could not reach the server.')).getAttribute('class')).toContain('ccp-error')
  })
})

describe('AgentList', () => {
  it('lists agents and close returns done', async () => {
    const client = fakeClient()
    render(<AgentList client={client} />)
    expect((await screen.findByTestId('state-ag1')).textContent).toBe('working')
    fireEvent.click(screen.getByRole('button', { name: 'Close ag1' }))
    await waitFor(() => expect(client.agentAction).toHaveBeenCalledWith('ag1', 'close', undefined))
    expect(await screen.findByText('Done.')).toBeTruthy()
  })

  it('relay that needs approval points to the Approvals tab', async () => {
    const onApprovalRequested = vi.fn()
    const client = fakeClient({ agentAction: vi.fn(async () => ({ status: 'needs_approval' as const, approvalId: 'ap1' })) })
    render(<AgentList client={client} onApprovalRequested={onApprovalRequested} />)
    await screen.findByTestId('state-ag1')
    fireEvent.click(screen.getByRole('button', { name: 'Relay ag1' }))
    fireEvent.change(screen.getByLabelText('Message to relay'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(client.agentAction).toHaveBeenCalledWith('ag1', 'relay', 'hello'))
    expect(await screen.findByText(/Approval requested/)).toBeTruthy()
    expect(onApprovalRequested).toHaveBeenCalled()
  })
})

describe('ApprovalCardR2', () => {
  it('R2 shows the server summary, tier and key args, and approves in one click', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<ApprovalCardR2 card={R2} onDecide={onDecide} />)
    expect(screen.getByTestId('server-summary').textContent).toBe(R2.summary)
    expect(screen.getByText('R2')).toBeTruthy()
    expect(screen.getByText('/work/webterm')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(R2, true))
  })

  it('R3 refuses approve until the exact phrase is typed', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<ApprovalCardR2 card={R3} onDecide={onDecide} />)
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.click(approve)
    expect(onDecide).not.toHaveBeenCalled()
    const input = screen.getByLabelText(/Type APPROVE to confirm/)
    fireEvent.change(input, { target: { value: 'approve' } })
    expect(approve.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'APPROVE' } })
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(R3, true))
  })

  it('an expired card cannot be approved but can be rejected', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<ApprovalCardR2 card={{ ...R2, expiresAt: 5 }} onDecide={onDecide} now={() => 10} />)
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Expired')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(expect.anything(), false))
  })

  it('queue decides through the client and reloads', async () => {
    const client = fakeClient()
    render(<ApprovalQueue client={client} />)
    await screen.findByRole('article', { name: 'agent.spawn R2' })
    expect(screen.getByRole('article', { name: 'project.merge R3' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!)
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith(R2, true))
    await waitFor(() => expect(client.listApprovals).toHaveBeenCalledTimes(2))
  })
})

describe('SkillReview', () => {
  it('shows lint and diff and approves only with the typed phrase', async () => {
    const client = fakeClient()
    render(<SkillReview client={client} />)
    expect(await screen.findByText('Lint passed')).toBeTruthy()
    expect(screen.getByLabelText('Diff').textContent).toContain('+added line')
    const approve = screen.getByRole('button', { name: 'Approve skill' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type APPROVE/), { target: { value: 'APPROVE' } })
    fireEvent.click(approve)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith('webterm-x', '1'))
  })

  it('failed lint blocks approval; active skill offers rollback', async () => {
    const base = (await fakeClient().listSkills())[0]!
    const client = fakeClient({ listSkills: vi.fn(async () => [
      { ...base, lint: { ok: false, findings: ['secret found'] } },
      { ...base, record: { ...base.record, name: 'webterm-y', status: 'active' as const } },
    ]) })
    render(<SkillReview client={client} />)
    expect(await screen.findByText('Lint failed')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Type APPROVE/), { target: { value: 'APPROVE' } })
    expect((screen.getByRole('button', { name: 'Approve skill' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Rollback' }))
    await waitFor(() => expect(client.rollbackSkill).toHaveBeenCalledWith('webterm-y'))
  })
})

describe('MemoryView', () => {
  it('renders scope/trust/kind and hides secret-looking values', async () => {
    render(<MemoryView client={fakeClient()} />)
    expect(await screen.findByRole('table', { name: 'Memory (read-only)' })).toBeTruthy()
    expect(screen.getByText('bun + react')).toBeTruthy()
    expect(screen.queryByText(/sk_live/)).toBeNull()
    expect(screen.getByText('[hidden: looks like a secret]')).toBeTruthy()
    expect(screen.getAllByRole('columnheader')).toHaveLength(5)
  })

  it('looksSecret flags credentials, not prose', () => {
    expect(looksSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(looksSecret('Bearer abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(looksSecret('use bun and react')).toBe(false)
  })
})
