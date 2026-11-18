/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BrowserNewTabPage, normalizeAddress } from './BrowserNewTabPage'
import { BrowserTabStateView } from './BrowserTabStates'
import { makeTab } from './browserTabsHarness'

describe('normalizeAddress', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['https://a.test/x?y=1', 'https://a.test/x?y=1'],
    ['localhost:3000/app', 'http://localhost:3000/app'],
    ['  127.0.0.1:8700 ', 'http://127.0.0.1:8700'],
  ])('%s -> %s', (input, url) => expect(normalizeAddress(input)).toEqual({ ok: true, url }))

  it.each(['', '   ', 'hello world', 'plainword', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi'])('rejects %j', (input) => {
    expect(normalizeAddress(input)).toMatchObject({ ok: false })
  })
})

describe('BrowserNewTabPage', () => {
  const setup = (over: Partial<React.ComponentProps<typeof BrowserNewTabPage>> = {}) => {
    const onNavigate = vi.fn()
    const onReopen = vi.fn()
    render(<BrowserNewTabPage closed={[makeTab('x', { title: 'Docs' }), makeTab('y', { title: '' })]} onNavigate={onNavigate} onReopen={onReopen} {...over} />)
    return { onNavigate, onReopen }
  }

  it('focuses the address field and navigates on submit', () => {
    const { onNavigate } = setup()
    const field = screen.getByRole('textbox', { name: 'Web address' })
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onNavigate).toHaveBeenCalledWith('https://example.org')
  })

  it('shows a clear error for a bad address and clears it on typing', () => {
    const { onNavigate } = setup()
    const field = screen.getByRole('textbox', { name: 'Web address' })
    fireEvent.change(field, { target: { value: 'nonsense' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(screen.getByRole('alert').textContent).toContain('Enter a web address')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(onNavigate).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'nonsense.' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lists recently closed tabs and reopens the clicked one', () => {
    const { onReopen } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }))
    expect(onReopen).toHaveBeenCalledWith('x')
    expect(screen.getByRole('button', { name: /y\.example\.com/ })).toBeTruthy() // title falls back to the host
  })

  it('says when nothing was closed, and disables reopen with the limit reason', () => {
    const empty = render(<BrowserNewTabPage closed={[]} onNavigate={vi.fn()} onReopen={vi.fn()} />)
    expect(screen.getByText('No recently closed tabs')).toBeTruthy()
    empty.unmount()
    const { onReopen } = setup({ reopenBlockedReason: 'Tab limit (8) reached' })
    expect(screen.getByRole('status').textContent).toBe('Tab limit (8) reached')
    const row = screen.getByRole('button', { name: /Docs/ }) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(onReopen).not.toHaveBeenCalled()
  })
})

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
