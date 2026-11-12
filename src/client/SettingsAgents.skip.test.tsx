/** @vitest-environment jsdom */
// Settings › Claude › Advanced › Add menu + custom agents (SettingsAgents.tsx): the old Agent page's
// Claude controls (skip approvals, permission mode, hook approvals, profiles, models) are not here anymore;
// the permissions choice is ClaudeSettingsSection.test.tsx.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { CustomAgentsSettings } from './SettingsAgents'

afterEach(cleanup)

describe('CustomAgentsSettings', () => {
  it('holds only the Add menu and custom agents', () => {
    render(<CustomAgentsSettings settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    for (const gone of ['Skip approvals', 'Claude permission mode', 'Hook approvals from the canvas', 'Claude launch profiles', 'Per-workspace model']) {
      expect(screen.queryByText(gone), gone).toBeNull()
    }
    expect(screen.getByText('Agents in the Add menu')).toBeTruthy()
    expect(screen.getByText('Custom agents')).toBeTruthy()
  })

  it('Add agent appends a custom agent', () => {
    const onChange = vi.fn()
    render(<CustomAgentsSettings settings={DEFAULT_SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    expect(onChange.mock.calls[0]?.[0].customAgents).toEqual([expect.objectContaining({ label: 'Custom agent', launchCmd: '' })])
  })
})
