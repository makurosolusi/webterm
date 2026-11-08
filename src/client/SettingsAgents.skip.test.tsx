/** @vitest-environment jsdom */
// Skip approvals switch in Settings › Agent: when on it locks the permission mode select.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
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

  it('when on, the permission mode select is disabled and says why', () => {
    render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, skipApprovals: true }} onChange={vi.fn()} />)
    expect((screen.getByLabelText('Skip approvals') as HTMLInputElement).checked).toBe(true)
    expect(modeSelect().disabled).toBe(true)
    expect(screen.getByText('Skip approvals is on, so every agent runs without prompts.')).toBeTruthy()
    expect(screen.getByText(/nothing stops a wrong action/).getAttribute('style')).toContain('--st-warning')
  })

  it('when off, the permission mode select is enabled and toggling on sends skipApprovals: true', () => {
    const onChange = vi.fn()
    render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, skipApprovals: false }} onChange={onChange} />)
    expect(modeSelect().disabled).toBe(false)
    expect(screen.queryByText('Skip approvals is on, so every agent runs without prompts.')).toBeNull()
    fireEvent.click(screen.getByLabelText('Skip approvals'))
    expect(onChange).toHaveBeenCalledWith({ skipApprovals: true })
  })

  it('names permission modes in plain words', () => {
    render(<AgentSettings settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect([...modeSelect().options].map((o) => o.textContent)).toEqual([
      'Ask before every action', 'Auto (default)', 'Approve file edits automatically', 'Plan only, change nothing', 'Never ask (no prompts)',
    ])
  })
})
