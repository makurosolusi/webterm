/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTabStateView } from './BrowserTabStates'
import { makeTab } from './browserTabsHarness'

describe('BrowserTabStateView', () => {
  const run = (tab = makeTab('a'), error?: { message: string; offline?: boolean }) => {
    const onReload = vi.fn()
    const onWake = vi.fn()
    const view = render(<BrowserTabStateView tab={tab} error={error} onReload={onReload} onWake={onWake} />)
    return { onReload, onWake, view }
  }

  it('renders nothing for a healthy tab', () => {
    const { view } = run()
    expect(view.container.innerHTML).toBe('')
  })

  it('crashed shows a Reload button that reloads', () => {
    const { onReload } = run(makeTab('a', { crashed: true, discarded: true }), { message: 'x' })
    expect(screen.getByRole('alert').textContent).toContain('This tab crashed')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('navigation error names the host and Retry reloads', () => {
    const { onReload } = run(makeTab('a'), { message: 'The site could not be reached' })
    expect(screen.getByRole('heading').textContent).toBe('Could not load a.example.com')
    expect(screen.getByText('The site could not be reached')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('offline uses its own heading', () => {
    run(makeTab('a'), { message: 'Check your connection', offline: true })
    expect(screen.getByRole('heading').textContent).toBe('You are offline')
  })

  it('discarded shows a spinner and wakes exactly once', () => {
    const { onWake, view } = run(makeTab('a', { discarded: true }))
    expect(screen.getByRole('status').textContent).toContain('Reloading Title a')
    expect(view.container.querySelector('.bt-spinner')).not.toBeNull()
    view.rerender(<BrowserTabStateView tab={makeTab('a', { discarded: true })} onReload={vi.fn()} onWake={onWake} />)
    expect(onWake).toHaveBeenCalledTimes(1)
  })
})
