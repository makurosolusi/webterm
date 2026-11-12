/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import SettingsHost from './SettingsHost'
import { OPEN_SETTINGS_EVENT, openLaunchProfileSettings } from './claudeLaunch.client'
import { openWorkspaceCanvasBackground } from '../canvasBackground.open'

const host = (section: Parameters<typeof SettingsHost>[0]['section'], onOpen = vi.fn(), onClose = vi.fn()) =>
  <SettingsHost section={section} onOpen={onOpen} onClose={onClose} settings={DEFAULT_SETTINGS} onChange={() => {}} />

describe('SettingsHost', () => {
  it('renders nothing while closed and asks for the event section and field on OPEN_SETTINGS_EVENT', () => {
    const onOpen = vi.fn()
    const { container } = render(host(null, onOpen))
    expect(container.innerHTML).toBe('')
    act(() => openLaunchProfileSettings())
    expect(onOpen).toHaveBeenCalledWith('claude', 'claudeLaunchProfiles')
  })

  it('drops an event field that is not a known setting id', () => {
    const onOpen = vi.fn()
    render(host(null, onOpen))
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'agent', field: 'nope' } })) })
    expect(onOpen).toHaveBeenCalledWith('claude', null) // the retired Agent page lands on Claude
  })

  it('maps a legacy event id to its route section', () => {
    const onOpen = vi.fn()
    render(host(null, onOpen))
    act(() => openWorkspaceCanvasBackground())
    expect(onOpen).toHaveBeenCalledWith('background', null)
  })

  it('shows the section it is given and reports nav clicks as section changes', async () => {
    const onOpen = vi.fn()
    render(host('claude', onOpen))
    const agent = await screen.findByRole('button', { name: 'Claude' })
    expect(agent.getAttribute('aria-current')).toBe('true')
    act(() => screen.getByRole('button', { name: 'Memory' }).click())
    expect(onOpen).toHaveBeenCalledWith('memory', null) // a plain section change clears the field
  })
})
