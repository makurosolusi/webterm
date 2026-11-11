/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppSetup, { resetSetupAutoOpen } from './App.setup'
import { openSetup } from './setup/setup.open'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))
// The real dialog shows itself from `?setup=`; here it only marks that AppSetup mounted it.
vi.mock('./setup/SetupDialog', () => ({ default: () => <div data-testid="setup-dialog" /> }))

const withSetup = (completedAt: number | null): Settings => ({ ...DEFAULT_SETTINGS, setup: { completedAt, steps: {} } }) // test-only
const mount = (settings: Settings, hydrated: boolean) => render(<AppSetup settings={settings} update={vi.fn()} hydrated={hydrated} />)

beforeEach(() => { resetSetupAutoOpen(); vi.mocked(openSetup).mockClear() })
afterEach(cleanup)

describe('AppSetup', () => {
  it('auto-opens once settings are hydrated and setup is incomplete', () => {
    const view = mount(withSetup(null), false)
    expect(openSetup).not.toHaveBeenCalled()
    view.rerender(<AppSetup settings={withSetup(null)} update={vi.fn()} hydrated />)
    expect(openSetup).toHaveBeenCalledTimes(1)
    expect(openSetup).toHaveBeenCalledWith()
  })

  it('does not auto-open a completed setup', () => {
    mount(withSetup(5), true)
    expect(openSetup).not.toHaveBeenCalled()
  })

  it('auto-opens only once per page load (a remount after closing does not reopen)', () => {
    mount(withSetup(null), true)
    cleanup()
    mount(withSetup(null), true)
    expect(openSetup).toHaveBeenCalledTimes(1)
  })

  it('always mounts the dialog, so ?setup= opens it even after setup was completed', () => {
    mount(withSetup(5), true)
    expect(screen.getByTestId('setup-dialog')).toBeTruthy()
  })
})
