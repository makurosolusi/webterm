/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTEXT_DANGER_PCT, CONTEXT_WARN_PCT, ContextMeter, contextLevel } from './contextMeter'

afterEach(cleanup)

describe('ContextMeter', () => {
  it('renders nothing without data or with an empty window', () => {
    const { container, rerender } = render(<ContextMeter />)
    expect(container.innerHTML).toBe('')
    rerender(<ContextMeter context={{ used: 10, window: 0 }} />)
    expect(container.innerHTML).toBe('')
  })

  it('bands at the named thresholds', () => {
    expect(contextLevel(CONTEXT_WARN_PCT - 1)).toBe('ok')
    expect(contextLevel(CONTEXT_WARN_PCT)).toBe('warn')
    expect(contextLevel(CONTEXT_DANGER_PCT - 1)).toBe('warn')
    expect(contextLevel(CONTEXT_DANGER_PCT)).toBe('danger')
  })

  it('shows the percentage and an exact token tooltip text, no /compact hint when low', () => {
    render(<ContextMeter context={{ used: 50_000, window: 200_000 }} />)
    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter.textContent).toBe('25%')
    expect(meter.getAttribute('aria-valuenow')).toBe('25')
    expect(meter.getAttribute('aria-valuetext')).toBe('50,000 of 200,000 tokens (25%)')
    expect(meter.dataset.level).toBe('ok')
  })

  it('turns warn / danger and hints /compact when high; clamps over-full windows', () => {
    const { rerender } = render(<ContextMeter context={{ used: 150_000, window: 200_000 }} />)
    const meter = () => screen.getByRole('meter')
    expect(meter().dataset.level).toBe('warn')
    expect(meter().getAttribute('aria-valuetext')).toContain('Run /compact')
    rerender(<ContextMeter context={{ used: 250_000, window: 200_000 }} />)
    expect(meter().dataset.level).toBe('danger')
    expect(meter().textContent).toBe('100%')
  })

  it('appends the detail line (session cost) to the tooltip only', () => {
    render(<ContextMeter context={{ used: 1, window: 4 }} detail="Session cost $0.1000" />)
    expect(screen.getByRole('meter').textContent).toBe('25%')
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe('1 of 4 tokens (25%). Session cost $0.1000')
  })
})
