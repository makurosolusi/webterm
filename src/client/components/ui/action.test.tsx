/** @vitest-environment jsdom */
// useAction / ActionButton / ActionResult / DisabledReason: minimum busy time, a repeated identical
// result still re-renders (new seq + time), failure toast with Retry, double clicks ignored, secrets masked.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionButton, ActionResult, errorCause, useAction, type ActionOptions } from './action'
import { DisabledReason } from './disabled-reason'

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 12, 10, 42, 5) }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

function Harness({ fn, opts }: { fn: () => Promise<string>; opts?: ActionOptions<string> }): React.JSX.Element {
  const action = useAction(fn, { label: 'Check', success: (r) => `Found ${r}`, ...opts })
  return <><ActionButton action={action} busyLabel="Checking…">Check</ActionButton><ActionResult action={action} stamp="checked" /></>
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('useAction + ActionButton + ActionResult', () => {
  it('stays busy for minBusyMs even when the work is instant, then shows the result with the time', async () => {
    render(<Harness fn={async () => 'Claude'} />)
    fireEvent.click(button('Check'))
    await flush()
    expect(button('Checking…').disabled).toBe(true)
    expect(button('Checking…').getAttribute('aria-busy')).toBe('true')
    await act(async () => { await vi.advanceTimersByTimeAsync(399) })
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(button('Check').disabled).toBe(false)
    expect(screen.getByRole('status').textContent).toMatch(/^Found Claude · checked 10[:.]42[:.]05/)
  })

  it('a repeated identical result gets a new seq and time', async () => {
    render(<Harness fn={async () => 'Claude'} />)
    fireEvent.click(button('Check'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    const first = document.querySelector('[data-action-result]')
    expect(first?.getAttribute('data-seq')).toBe('1')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    fireEvent.click(button('Check'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    const second = document.querySelector('[data-action-result]')
    expect(second?.getAttribute('data-seq')).toBe('2')
    expect(second).not.toBe(first) // remounted (key = seq): re-announced
    expect(screen.getByRole('status').textContent).toMatch(/10[:.]42[:.]08/)
  })

  it('a run that finishes after unmount does not touch React (no setState once the DOM is gone)', async () => {
    const { unmount } = render(<Harness fn={async () => 'Claude'} />)
    fireEvent.click(button('Check'))
    await flush()
    unmount()
    const win = globalThis.window
    vi.stubGlobal('window', undefined) // what vitest teardown does to jsdom
    try { await vi.advanceTimersByTimeAsync(400) } finally { vi.stubGlobal('window', win) }
  })

  it('ignores clicks while running', async () => {
    const fn = vi.fn(async () => 'x')
    render(<Harness fn={fn} />)
    fireEvent.click(button('Check'))
    fireEvent.click(button('Checking…'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('failure: alert line naming the operation and cause, a toast, and Retry runs it again', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('server unreachable')).mockResolvedValueOnce('Claude')
    render(<Harness fn={fn} />)
    fireEvent.click(button('Check'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Check failed: server unreachable', { selector: '[role=alert] > span' })).toBeTruthy()
    expect(document.querySelector('[data-slot="vscode-notification"]')?.getAttribute('data-severity')).toBe('error')
    fireEvent.click(button('Retry'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toContain('Found Claude')
    expect(document.querySelector('[data-slot="vscode-notification"]')).toBeNull()
  })

  it("ok(r) false shows a resolved result as failure; toast 'never' keeps it inline", async () => {
    render(<Harness fn={async () => 'nothing'} opts={{ ok: () => false, toast: 'never' }} />)
    fireEvent.click(button('Check'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByRole('alert').textContent).toContain('Found nothing')
    expect(document.querySelector('[data-slot="vscode-notification"]')).toBeNull()
  })

  it('a lock disables the button and shows why', () => {
    function Locked(): React.JSX.Element {
      const action = useAction(async () => 'x')
      return <ActionButton action={action} busyLabel="…" lock={{ reason: 'Central is off.' }}>Check</ActionButton>
    }
    render(<Locked />)
    expect(button('Check').disabled).toBe(true)
    expect(screen.getByText('Central is off.')).toBeTruthy()
  })
})

describe('errorCause', () => {
  it('masks token-like strings and caps the length', () => {
    expect(errorCause(new Error('bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'))).toBe('bad key ***')
    expect(errorCause('x'.repeat(500)).length).toBeLessThanOrEqual(200)
    expect(errorCause({})).toBe('unknown error')
  })
})

describe('DisabledReason', () => {
  it('shows the reason with a lock and a fix button', () => {
    const run = vi.fn()
    render(<DisabledReason id="r" reason="Skip approvals is on." fix={{ label: 'Turn it off', run }} />)
    expect(document.getElementById('r')?.querySelector('.codicon-lock')).toBeTruthy()
    fireEvent.click(button('Turn it off'))
    expect(run).toHaveBeenCalledTimes(1)
  })
})
