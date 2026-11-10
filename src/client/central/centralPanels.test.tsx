/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentList from './AgentList'
import LevelPanel from './LevelPanel'
import MemoryView, { looksSecret } from './MemoryView'
import SkillReview from './SkillReview'
import { fakeClient } from './centralFixtures.testutil'
import * as needsYou from '../chat/needsYouApi'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SettingsProvider } from '../useSettings'

afterEach(cleanup)

describe('LevelPanel', () => {
  it('shows the level in plain words, the budget in compact numbers and reports status', async () => {
    const onStatus = vi.fn()
    const client = fakeClient({ getStatus: vi.fn(async () => ({ budget: { day: 'd', used: { tokens: 13_000, spawns: 0 }, limits: { tokens: 10_000_000, spawns: 20 } }, model: { id: 'opencode/free', free: true }, lastTurn: null })) })
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, skipApprovals: false }}><LevelPanel client={client} onStatus={onStatus} /></SettingsProvider>)
    expect((await screen.findByTestId('level-effective')).textContent).toBe('L2 Proposes work, you approve')
    expect(screen.getByText(/nothing runs until you approve it/)).toBeTruthy()
    expect(screen.queryByText(/Limited by your highest allowed level/)).toBeNull()
    expect(await screen.findByText('13K of 10M tokens today')).toBeTruthy()
    expect(screen.getByText('0 of 20 workers started today')).toBeTruthy()
    const bar = screen.getByRole('progressbar', { name: 'Tokens' }) as HTMLProgressElement
    expect(bar.value).toBeGreaterThan(0) // tiny use still shows
    expect(bar.getAttribute('aria-valuetext')).toBe('13K of 10M tokens today')
    expect((screen.getByRole('progressbar', { name: 'Workers' }) as HTMLProgressElement).value).toBe(0)
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ model: { id: 'opencode/free', free: true } })))
  })

  it('says when the highest allowed level holds Central below the chosen one; no limit reads plainly', async () => {
    const client = fakeClient({
      getControl: vi.fn(async () => ({ ceiling: 'propose' as const, effective: 'propose' as const, global: { level: 'act_envelope' as const, version: 1, reason: null } })),
      getStatus: vi.fn(async () => ({ budget: { day: 'd', used: { tokens: 1_500, spawns: 0 }, limits: { tokens: 0, spawns: 0 } }, model: { id: 'paid', free: false }, lastTurn: null })),
    })
    render(<LevelPanel client={client} />)
    expect(await screen.findByText('Limited by your highest allowed level.')).toBeTruthy()
    expect(await screen.findByText('1.5K · No limit')).toBeTruthy()
    expect(screen.getByText('0 · None allowed')).toBeTruthy()
  })

  it('halt needs confirmation and can be cancelled', async () => {
    const client = fakeClient()
    render(<LevelPanel client={client} />)
    await screen.findByTestId('level-effective')
    fireEvent.click(screen.getByRole('button', { name: 'Stop Central' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(client.halt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(client.halt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop Central' }))
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: ' stop ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop Central' }))
    await waitFor(() => expect(client.halt).toHaveBeenCalledWith('stop'))
    expect(await screen.findByText(/Central is stopped/)).toBeTruthy()
  })

  it('"Change" opens Settings on the Central Agent section', async () => {
    const seen: unknown[] = []
    const on = (e: Event): void => { seen.push((e as CustomEvent).detail) }
    window.addEventListener('webterm:open-settings', on)
    render(<LevelPanel client={fakeClient()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change in Central settings' }))
    window.removeEventListener('webterm:open-settings', on)
    expect(seen).toEqual([{ section: 'central' }])
  })

  it('says approvals are skipped when the setting is on, and "Change" opens Settings › Agent', async () => {
    const seen: unknown[] = []
    const on = (e: Event): void => { seen.push((e as CustomEvent).detail) }
    window.addEventListener('webterm:open-settings', on)
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, skipApprovals: true }}><LevelPanel client={fakeClient()} /></SettingsProvider>)
    expect(screen.getByText(/Approvals: skipped — Central acts without asking/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change in Agent settings' }))
    window.removeEventListener('webterm:open-settings', on)
    expect(seen).toEqual([{ section: 'agent' }])
  })

  it('shows no approvals line when the setting is off', async () => {
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, skipApprovals: false }}><LevelPanel client={fakeClient()} /></SettingsProvider>)
    await screen.findByTestId('level-effective')
    expect(screen.queryByText(/Approvals: skipped/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change in Agent settings' })).toBeNull()
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

  it('relay that needs approval points to the Needs-you list and refreshes it', async () => {
    const refresh = vi.spyOn(needsYou, 'refreshNeedsYou').mockResolvedValue(undefined)
    const client = fakeClient({ agentAction: vi.fn(async () => ({ status: 'needs_approval' as const, approvalId: 'ap1' })) })
    render(<AgentList client={client} />)
    await screen.findByTestId('state-ag1')
    fireEvent.click(screen.getByRole('button', { name: 'Relay ag1' }))
    fireEvent.change(screen.getByLabelText('Message to relay'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(client.agentAction).toHaveBeenCalledWith('ag1', 'relay', 'hello'))
    expect((await screen.findByText(/Approval requested/)).textContent).toContain('Needs-you list of the Central chat')
    expect(refresh).toHaveBeenCalled()
    refresh.mockRestore()
  })
})

describe('SkillReview', () => {
  it('shows lint and diff and approves only with the typed phrase', async () => {
    const client = fakeClient()
    render(<SkillReview client={client} />)
    expect(await screen.findByText('Lint passed')).toBeTruthy()
    expect(screen.getByLabelText('Diff').textContent).toContain('+added line')
    const approve = screen.getByRole('button', { name: /^Approve skill/ }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type APPROVE/), { target: { value: 'APPROVE' } })
    fireEvent.click(approve)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith('webterm-x', '1', 'APPROVE'))
  })

  it('failed lint blocks approval; active skill offers rollback', async () => {
    const base = (await fakeClient().listSkills())[0]!
    const client = fakeClient({ listSkills: vi.fn(async () => [
      { ...base, lint: { ok: false, findings: ['secret found'] } },
      { ...base, record: { ...base.record, name: 'webterm-y', status: 'active' as const }, canRollback: true },
    ]) })
    render(<SkillReview client={client} />)
    expect(await screen.findByText('Lint failed')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Type APPROVE/), { target: { value: 'APPROVE' } })
    expect((screen.getByRole('button', { name: /^Approve skill/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Rollback/ }))
    await waitFor(() => expect(client.rollbackSkill).toHaveBeenCalledWith('webterm-y'))
  })
})

describe('MemoryView', () => {
  it('renders scope/trust/kind and hides secret-looking values', async () => {
    render(<MemoryView client={fakeClient()} />)
    expect(await screen.findByRole('table', { name: "Central's memory" })).toBeTruthy()
    expect(screen.getByText('bun + react')).toBeTruthy()
    expect(screen.queryByText(/sk_live/)).toBeNull()
    expect(screen.getByText('[hidden: looks like a password or key]')).toBeTruthy()
    expect(screen.getAllByRole('columnheader')).toHaveLength(5)
  })

  it('looksSecret flags credentials, not prose', () => {
    expect(looksSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(looksSecret('Bearer abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(looksSecret('use bun and react')).toBe(false)
  })
})
