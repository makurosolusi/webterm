/**
 * @vitest-environment jsdom
 */
// Banner restart: label manusia dari entri pendingRestart, bertahan setelah komponen lain unmount.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvRestartBanner } from './EnvRestartBanner'
import { baseState, EnvHarness, stubEnvApi } from './envTestFixtures'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EnvRestartBanner', () => {
  it('renders nothing when no entry is pending restart', async () => {
    const stub = stubEnvApi(baseState())
    const { container } = render(<EnvHarness><EnvRestartBanner /></EnvHarness>)
    await waitFor(() => expect(stub.calls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector('.st-env-restart')).toBeNull()
  })

  it('lists human labels (not KEYs) of pending entries', async () => {
    const st = baseState()
    st.entries = st.entries.map((e) => (e.key === 'K_ONE' ? { ...e, pendingRestart: true, label: 'Fitur Satu' } : e.key === 'K_TWO' ? { ...e, pendingRestart: true, label: 'Fitur Dua' } : e))
    stubEnvApi(st)
    render(<EnvHarness><EnvRestartBanner /></EnvHarness>)
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Perlu restart server untuk: Fitur Satu, Fitur Dua')
    expect(status.textContent).not.toContain('K_ONE')
  })

  it('survives unmounting a sibling consumer because state lives in the provider', async () => {
    const st = baseState()
    st.entries = st.entries.map((e) => (e.key === 'K_ONE' ? { ...e, pendingRestart: true } : e))
    stubEnvApi(st)
    function Page({ showOther }: { showOther: boolean }): React.JSX.Element {
      return <EnvHarness>{showOther ? <p>other</p> : null}<EnvRestartBanner /></EnvHarness>
    }
    const { rerender } = render(<Page showOther />)
    await screen.findByRole('status')
    rerender(<Page showOther={false} />)
    expect(screen.getByRole('status').textContent).toContain('Label K_ONE')
  })
})
