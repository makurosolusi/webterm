/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import SettingsHost from './SettingsHost'
import { openLaunchProfileSettings } from './claudeLaunch.client'

describe('SettingsHost', () => {
  it('renders nothing while closed and opens on OPEN_SETTINGS_EVENT', () => {
    const setOpen = vi.fn()
    const { container } = render(<SettingsHost open={false} setOpen={setOpen} settings={DEFAULT_SETTINGS} onChange={() => {}} />)
    expect(container.innerHTML).toBe('')
    act(() => openLaunchProfileSettings())
    expect(setOpen).toHaveBeenCalledWith(true)
  })
})
