/** @vitest-environment jsdom */
// The app-wide connection strip, driven through the real connection store (ws.connection.ts) with
// a fake retry handler: each phase, countdown, Retry now, restart notice, new build, auth hand-off.
// Also the per-terminal overlay, which must say input is paused but carry no countdown/Retry.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import ConnectionStatus, { CONNECTING_GRACE_MS, CONNECTION_TEXT, RESTART_NOTICE_MS } from './ConnectionStatus'
import { TERMINAL_OFFLINE_TEXT, TerminalOffline } from './TerminalCore.offline'
import { setConnection, setRetryHandler, type ConnectionState } from './ws.connection'

const retry = vi.fn()

/** Replace the whole store state (setConnection merges). */
function phase(next: Partial<ConnectionState>): void {
  act(() => setConnection({ phase: 'connected', attempt: 0, serverRestartedAt: undefined, buildChanged: false, ...next }))
}

function mount(props: { onAuthRequired?: () => void; reload?: () => void } = {}) {
  return render(
    <TooltipProvider>
      <ConnectionStatus onAuthRequired={props.onAuthRequired ?? (() => {})} reload={props.reload} />
    </TooltipProvider>,
  )
}

const strip = (): HTMLElement => screen.getByRole('status', { name: CONNECTION_TEXT.label })

beforeEach(() => {
  vi.useFakeTimers()
  retry.mockReset()
  setRetryHandler(retry)
  phase({})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ConnectionStatus', () => {
  it('is an empty polite live region while connected', () => {
    mount()
    expect(strip().getAttribute('aria-live')).toBe('polite')
    expect(strip().textContent).toBe('')
  })

  it('shows nothing for the first moments of the boot connect, then "Connecting…"', () => {
    phase({ phase: 'connecting' })
    mount()
    expect(strip().textContent).toBe('')
    act(() => { vi.advanceTimersByTime(CONNECTING_GRACE_MS - 10) })
    expect(strip().textContent).toBe('')
    act(() => { vi.advanceTimersByTime(20) })
    expect(strip().textContent).toBe(CONNECTION_TEXT.connecting)
    phase({ phase: 'connected' })
    expect(strip().textContent).toBe('')
  })

  it('counts down to the next retry and "Retry now" calls retryNow', () => {
    mount()
    phase({ phase: 'reconnecting', attempt: 2, retryAt: Date.now() + 3000 })
    expect(strip().textContent).toContain(CONNECTION_TEXT.reconnecting(3))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(strip().textContent).toContain(CONNECTION_TEXT.reconnecting(2))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(strip().textContent).toContain('Reconnecting…')
    expect(strip().textContent).not.toContain('retrying in')
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.retry }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('says changes are kept while the browser is offline', () => {
    mount()
    phase({ phase: 'offline' })
    expect(strip().textContent).toBe(CONNECTION_TEXT.offline)
  })

  it('announces a server restart after reconnect, then dismisses it by itself', () => {
    mount()
    phase({ phase: 'reconnecting' })
    phase({ phase: 'connected', serverRestartedAt: 1234 })
    expect(strip().textContent).toBe(CONNECTION_TEXT.restarted)
    act(() => { vi.advanceTimersByTime(RESTART_NOTICE_MS) })
    expect(strip().textContent).toBe('')
  })

  it('the restart notice can be dismissed and does not come back for the same restart', () => {
    mount()
    phase({ phase: 'connected', serverRestartedAt: 99 })
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.dismiss }))
    expect(strip().textContent).toBe('')
    phase({ phase: 'reconnecting', serverRestartedAt: 99 })
    phase({ phase: 'connected', serverRestartedAt: 99 })
    expect(strip().textContent).toBe('')
  })

  it('keeps "A new version is available" up with a Reload button', () => {
    const reload = vi.fn()
    mount({ reload })
    phase({ phase: 'connected', buildChanged: true })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(strip().textContent).toContain(CONNECTION_TEXT.newVersion)
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.reload }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('hands a refused credential to App (which shows SignInScreen)', () => {
    const onAuthRequired = vi.fn()
    mount({ onAuthRequired })
    expect(onAuthRequired).not.toHaveBeenCalled()
    phase({ phase: 'auth' })
    expect(onAuthRequired).toHaveBeenCalled()
  })
})

describe('TerminalOffline', () => {
  it('says input is paused while disconnected, with no countdown or Retry of its own', () => {
    render(<TerminalOffline />)
    expect(screen.queryByText(TERMINAL_OFFLINE_TEXT)).toBeNull()
    phase({ phase: 'reconnecting', retryAt: Date.now() + 5000 })
    expect(screen.getByRole('status').textContent).toBe(TERMINAL_OFFLINE_TEXT)
    expect(screen.queryByRole('button')).toBeNull()
    phase({ phase: 'offline' })
    expect(screen.getByText(TERMINAL_OFFLINE_TEXT)).toBeTruthy()
    phase({ phase: 'connected' })
    expect(screen.queryByText(TERMINAL_OFFLINE_TEXT)).toBeNull()
  })

  it('stays hidden during the boot connect (nothing was lost yet)', () => {
    phase({ phase: 'connecting' })
    render(<TerminalOffline />)
    expect(screen.queryByText(TERMINAL_OFFLINE_TEXT)).toBeNull()
  })
})
