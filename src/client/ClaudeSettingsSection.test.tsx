/** @vitest-environment jsdom */
// Settings › Claude: the effective-launch line and profile badges come from the server (command mode
// included), Central's own pick shows as a deviation, the one permissions choice writes `agentApprovalLevel`,
// the raw permission mode sits under Advanced locked by "Never ask", and no Claude bits are left elsewhere.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { applySettingsPatch, type SettingsPatch } from '../shared/settings.patch'
import type { EffectiveClaudeLaunch } from '../shared/claudeLaunch/claudeLaunch.effective'
import { SettingsItemScopeProvider } from './settingsContext'
import { ClaudeSettingsSection } from './ClaudeSettingsSection'

// test-only fixtures
const ENV = { id: 'e', name: 'Envman', command: 'envman -e claude:x -- claude' }
const OWN = { id: 'c', name: 'Central only', command: 'claude --model opus' }
let effective: EffectiveClaudeLaunch | { error: string }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  effective = {
    agents: { profileId: 'e', name: 'Envman', command: ENV.command },
    central: { profileId: 'e', name: 'Envman', command: ENV.command, source: 'default' },
    credential: 'command', deviations: [],
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/claude-launch/effective') return 'error' in effective ? json(effective, 500) : json(effective)
    if (url === '/api/claude-provider') return json({ provider: { mode: 'command', profileId: 'e', secretSet: false, ready: true }, lastTest: null, restartNeeded: 0 })
    return json({})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness({ initial = {}, spy }: { initial?: Partial<Settings>; spy?: (p: SettingsPatch) => void }): React.JSX.Element {
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [ENV, OWN], ...initial })
  const onChange = (p: SettingsPatch): void => { spy?.(p); setS((cur) => applySettingsPatch(cur, p)) }
  return (
    <SettingsItemScopeProvider category="Claude" settings={s} onChange={onChange}>
      <ClaudeSettingsSection settings={s} onChange={onChange} />
      <output data-testid="keys">{JSON.stringify({ skip: s.skipApprovals, mode: s.claudePermissionMode, level: s.agentApprovalLevel })}</output>
    </SettingsItemScopeProvider>
  )
}
const keys = () => JSON.parse(screen.getByTestId('keys').textContent ?? '{}')
const line = () => document.querySelector('[data-effective-launch]') as HTMLElement

describe('Connection', () => {
  it('says what agents, Central and helpers start with, from the server', async () => {
    render(<Harness />)
    await waitFor(() => expect(line().textContent).toContain('New Claude agents, Central and helpers start with: envman -e claude:x -- claude'))
    expect(line().textContent).toContain('supplied by your command')
  })

  it('badges follow the server, not the stored default (command mode moved it)', async () => {
    render(<Harness initial={{ defaultClaudeProfileId: 'default' }} />)
    const envRow = await screen.findByRole('region', { name: 'Envman' })
    await waitFor(() => expect(within(envRow).queryByText('Default for new agents')).toBeTruthy())
    expect(within(screen.getByRole('region', { name: 'Default' })).queryByText('Default for new agents')).toBeNull()
    expect(screen.queryByLabelText('Default for new Claude agents')).toBeNull() // one concept: the Connection choice
  })

  it("Central's own pick is a deviation line whose Change reveals the Advanced field", async () => {
    effective = {
      agents: { profileId: 'e', name: 'Envman', command: ENV.command },
      central: { profileId: 'c', name: 'Central only', command: OWN.command, source: 'central' },
      credential: 'login', deviations: [{ who: 'central', profileId: 'c', name: 'Central only' }],
    }
    const opened = vi.fn()
    window.addEventListener('webterm:open-settings', opened)
    render(<Harness initial={{ centralClaudeProfileId: 'c' }} />)
    await waitFor(() => expect(line().textContent).toContain('New Claude agents and helpers start with:'))
    expect(line().textContent).toContain('Central uses Central only.')
    fireEvent.click(within(line()).getByRole('button', { name: 'Change' }))
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'claude', field: 'centralClaudeProfileId' })
    window.removeEventListener('webterm:open-settings', opened)
  })

  it('a failed check says so with Retry', async () => {
    effective = { error: 'boom' }
    render(<Harness />)
    await waitFor(() => expect(within(line()).getByRole('button', { name: 'Retry' })).toBeTruthy())
    expect(line().textContent).toContain('(boom)')
  })
})

describe('Permissions', () => {
  const level = () => screen.getByLabelText('How much may agents do on their own?') as HTMLSelectElement

  it('one select with three levels; each writes the mapped runtime keys', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    expect([...level().options].map((o) => o.textContent)).toEqual(['Never ask', 'Ask for risky things', 'Ask every time'])
    fireEvent.change(level(), { target: { value: 'risky' } })
    expect(spy).toHaveBeenLastCalledWith({ agentApprovalLevel: 'risky' })
    expect(keys()).toEqual({ skip: false, mode: 'auto', level: 'risky' })
    fireEvent.change(level(), { target: { value: 'always' } })
    expect(keys()).toEqual({ skip: false, mode: 'manual', level: 'always' })
    fireEvent.change(level(), { target: { value: 'never' } })
    expect(keys()).toMatchObject({ skip: true, level: 'never' })
  })

  it('"Never ask" reads as a warning; the separate skip / hook switches are gone', () => {
    render(<Harness initial={{ skipApprovals: true, agentApprovalLevel: 'never' }} />)
    expect(screen.getByText(/act without asking you first/)).toBeTruthy()
    expect(screen.queryByLabelText('Skip approvals')).toBeNull()
    expect(screen.queryByLabelText('Hook approvals from the canvas')).toBeNull()
  })

  it('raw permission mode lives under Advanced, locked by Never ask, with a fix to the risky level', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} initial={{ skipApprovals: true, agentApprovalLevel: 'never' }} />)
    const raw = screen.getByLabelText('Claude permission mode') as HTMLSelectElement
    expect(raw.closest('details')).toBeTruthy()
    expect(raw.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Ask for risky things instead' }))
    expect(spy).toHaveBeenLastCalledWith({ agentApprovalLevel: 'risky' })
    expect((screen.getByLabelText('Claude permission mode') as HTMLSelectElement).disabled).toBe(false)
  })
})

describe('Models and Advanced', () => {
  it('models are automatic; no per-workspace editor; Advanced holds Central profile, Add menu, custom agents', () => {
    render(<Harness />)
    expect(screen.getByText(/Models are chosen automatically/)).toBeTruthy()
    expect(screen.queryByText('Per-workspace model')).toBeNull()
    const advanced = document.querySelector('[data-claude-group="advanced"]') as HTMLDetailsElement
    expect(advanced.open).toBe(false)
    for (const field of ['centralClaudeProfileId', 'claudePermissionMode', 'disabledAgents', 'customAgents']) {
      expect(advanced.querySelector(`[data-field="${field}"]`), field).toBeTruthy()
    }
  })
})
