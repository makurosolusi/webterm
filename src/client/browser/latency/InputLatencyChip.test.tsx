/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InputLatencyChip from './InputLatencyChip'
import { createLatencyWindow, LATENCY_IDLE_MS, recordFrame } from './inputLatency.window'

const lat = (ls: number) => ({ ls, rxToDispatch: 1, dispatchToSwap: 5, swapToServer: 1 }) // test-only

describe('InputLatencyChip', () => {
  let clock = 10_000
  const now = () => clock
  beforeEach(() => { vi.useFakeTimers(); clock = 10_000 })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('hidden with no samples, appears with p50/p95, hides again when idle', () => {
    const w = createLatencyWindow()
    const { container } = render(<InputLatencyChip window={w} now={now} />)
    expect(container.firstChild).toBeNull()
    recordFrame(w, lat(clock - 38), clock - 2, clock)
    act(() => { vi.advanceTimersByTime(500) })
    const chip = screen.getByRole('button')
    expect(chip.textContent).toBe('38 ms · p95 38 ms')
    expect(chip.dataset.tone).toBe('good')
    clock += LATENCY_IDLE_MS + 1
    act(() => { vi.advanceTimersByTime(500) })
    expect(container.firstChild).toBeNull()
  })

  it.each([[40, 'good'], [80, 'warn'], [150, 'bad']])('total %d ms -> tone %s', (total, tone) => {
    const w = createLatencyWindow()
    recordFrame(w, lat(clock - total), clock - 1, clock)
    render(<InputLatencyChip window={w} now={now} />)
    expect(screen.getByRole('button').dataset.tone).toBe(tone)
  })

  it('click toggles the per-stage breakdown', () => {
    const w = createLatencyWindow()
    recordFrame(w, lat(clock - 30), clock - 4, clock) // network = 30 - 7 - 4 = 19
    render(<InputLatencyChip window={w} now={now} />)
    expect(screen.queryByLabelText('Input latency breakdown')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    const dl = screen.getByLabelText('Input latency breakdown')
    expect(dl.textContent).toContain('Network (send + return)19 ms')
    expect(dl.textContent).toContain('CDP dispatch → frame swap5 ms')
    expect(dl.textContent).toContain('Client receive → paint4 ms')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByLabelText('Input latency breakdown')).toBeNull()
  })
})
