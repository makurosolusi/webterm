/** @vitest-environment jsdom */
// Settings › Claude › Permissions: who answers agent permission prompts. Central first is the default for new and
// old installs; an explicit "Me" is kept; a click saves exactly one key.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings'
import { PermissionRoutingField, ROUTING_TEXT } from './PermissionRoutingField'

afterEach(cleanup)

describe('permission routing setting', () => {
  it('defaults to Central first, for a stored document that never had the key (old install)', () => {
    expect(DEFAULT_SETTINGS.permissionRouting).toBe('central')
    expect(mergeSettings({ centralCheckins: false }).permissionRouting).toBe('central')
    expect(mergeSettings({ permissionRouting: 'nonsense' }).permissionRouting).toBe('central')
  })

  it('honors an explicit stored choice', () => {
    expect(mergeSettings({ permissionRouting: 'human' }).permissionRouting).toBe('human')
  })

  it('shows both choices, marks the current one and saves only permissionRouting on click', () => {
    const onChange = vi.fn()
    render(<PermissionRoutingField settings={{ ...DEFAULT_SETTINGS }} onChange={onChange} />)
    expect(screen.getByText(ROUTING_TEXT.label)).toBeTruthy()
    const [central, me] = screen.getAllByRole('radio')
    expect(central?.getAttribute('aria-checked')).toBe('true')
    expect(me?.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(me!)
    expect(onChange).toHaveBeenCalledWith({ permissionRouting: 'human' })
    fireEvent.click(central!) // already selected: no write
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('reflects a stored Me', () => {
    render(<PermissionRoutingField settings={{ ...DEFAULT_SETTINGS, permissionRouting: 'human' }} onChange={() => {}} />)
    expect(screen.getAllByRole('radio')[1]?.getAttribute('aria-checked')).toBe('true')
  })
})
