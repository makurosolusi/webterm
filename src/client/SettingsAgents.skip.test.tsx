/** @vitest-environment jsdom */
// Skip approvals switch in Settings › Agent: when on it locks the permission mode select.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { isPermissionMode, type AgentPermissionMode } from '../shared/workspace'
import { AgentSettings } from './SettingsAgents'

afterEach(cleanup)

const modeSelect = (): HTMLSelectElement => screen.getByLabelText('Claude permission mode') as HTMLSelectElement

describe('AgentSettings skip approvals', () => {
  it('follows the shared default and toggling sends the opposite value', () => {
    const onChange = vi.fn()
    render(<AgentSettings settings={DEFAULT_SETTINGS} onChange={onChange} />)
    const toggle = screen.getByLabelText('Skip approvals') as HTMLInputElement
    expect(toggle.checked).toBe(DEFAULT_SETTINGS.skipApprovals)
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith({ skipApprovals: !DEFAULT_SETTINGS.skipApprovals })
  })

  it('when on, the permission mode select is disabled, keeps its own description, says why and links to the fix', () => {
    const onChange = vi.fn()
    render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, skipApprovals: true }} onChange={onChange} />)
    expect((screen.getByLabelText('Skip approvals') as HTMLInputElement).checked).toBe(true)
    expect(modeSelect().disabled).toBe(true)
    expect(screen.getByText(/passed as --permission-mode at launch/)).toBeTruthy()
    const reason = document.getElementById(modeSelect().getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain('Skip approvals is on, so agents start without asking.')
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Skip approvals to choose' }))
    expect(onChange).toHaveBeenCalledWith({ skipApprovals: false })
    // The hint is a plain string now (searchable); the warning lives in the text itself.
    expect(screen.getByText(/nothing stops a wrong action/)).toBeTruthy()
  })

  it('when off, the permission mode select is enabled and toggling on sends skipApprovals: true', () => {
    const onChange = vi.fn()
    render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, skipApprovals: false }} onChange={onChange} />)
    expect(modeSelect().disabled).toBe(false)
    expect(modeSelect().getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByText('Skip approvals is on, so agents start without asking.')).toBeNull()
    expect(screen.getByText(/passed as --permission-mode at launch/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Skip approvals'))
    expect(onChange).toHaveBeenCalledWith({ skipApprovals: true })
  })

  it('names permission modes in plain words', () => {
    render(<AgentSettings settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect([...modeSelect().options].map((o) => o.textContent)).toEqual([
      'Ask before every action', 'Auto (default)', 'Approve file edits automatically', 'Plan only, change nothing', 'Never ask (no prompts)',
    ])
  })

  it('every permission mode a session can hold is an option, so the select never shows blank for a valid value', () => {
    const modes: AgentPermissionMode[] = ['manual', 'auto', 'acceptEdits', 'plan', 'bypassPermissions']
    expect(modes.every(isPermissionMode)).toBe(true)
    for (const mode of modes) {
      cleanup()
      render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, skipApprovals: false, claudePermissionMode: mode }} onChange={vi.fn()} />)
      expect(modeSelect().value).toBe(mode)
      expect(modeSelect().selectedOptions[0]?.textContent).toBeTruthy()
    }
    expect([...modeSelect().options].map((o) => o.value).sort()).toEqual([...modes].sort())
  })
})
