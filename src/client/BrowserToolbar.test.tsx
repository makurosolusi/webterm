/** @vitest-environment jsdom */
// Toolbar + chip lease: validasi URL, tombol nav, toggle agent, chip Stop -> takeover.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState } from '../shared/browser.contract'
import BrowserLeaseChip from './BrowserLeaseChip'
import BrowserToolbar from './BrowserToolbar'
import { CHIP_TEXT, TOOLBAR_TEXT, URL_ERROR_TEXT, ZOOM_TEXT } from './browser.uxText'

afterEach(cleanup)
const st = (o: Partial<BrowserState> = {}): BrowserState =>
  ({ id: 'n1', url: 'https://a.com/', title: '', loading: false, canBack: true, canForward: false, lease: 'human', live: 'live', ...o })

function setup(state: BrowserState | undefined = st(), extra: Partial<Parameters<typeof BrowserToolbar>[0]> = {}) {
  const nav = vi.fn(); const onAgentControl = vi.fn()
  render(<BrowserToolbar state={state} nav={nav} agentControl={false} agentEnabled onAgentControl={onAgentControl} {...extra} />)
  return { nav, onAgentControl }
}
const address = () => screen.getByLabelText(TOOLBAR_TEXT.urlLabel) as HTMLInputElement

describe('BrowserToolbar', () => {
  it('shows the current url and submits a normalized valid url', () => {
    const { nav } = setup()
    expect(address().value).toBe('https://a.com/')
    fireEvent.change(address(), { target: { value: ' https://b.com/x?q=1 ' } })
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.go }))
    expect(nav).toHaveBeenCalledExactlyOnceWith('go', 'https://b.com/x?q=1')
  })

  it.each([
    ['javascript:alert(1)', 'scheme'], ['file:///etc/passwd', 'scheme'], ['https://u:p@a.com/', 'userinfo'],
  ] as const)('rejects %s without navigating', (value, reason) => {
    const { nav } = setup()
    fireEvent.change(address(), { target: { value } })
    fireEvent.submit(address().closest('form')!)
    expect(nav).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(URL_ERROR_TEXT[reason])
    expect(address().getAttribute('aria-invalid')).toBe('true')
  })

  it.each([
    ['github topic agent', 'https://www.google.com/search?q=github%20topic%20agent'],
    ['github.com', 'https://github.com/'],
    ['localhost:3000', 'http://localhost:3000/'],
  ])('omnibox: %s -> %s', (value, url) => {
    const { nav } = setup()
    fireEvent.change(address(), { target: { value } })
    fireEvent.submit(address().closest('form')!)
    expect(nav).toHaveBeenCalledExactlyOnceWith('go', url)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('searches with the configured engine and ignores a blank submit', () => {
    const { nav } = setup(st(), { searchEngine: 'bing' })
    fireEvent.change(address(), { target: { value: '   ' } })
    fireEvent.submit(address().closest('form')!)
    expect(nav).not.toHaveBeenCalled()
    fireEvent.change(address(), { target: { value: 'node.js tutorial' } })
    fireEvent.submit(address().closest('form')!)
    expect(nav).toHaveBeenCalledExactlyOnceWith('go', 'https://www.bing.com/search?q=node.js%20tutorial')
  })

  it('wires back/forward/reload and disables unavailable directions', () => {
    const { nav } = setup()
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.back }))
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.reload }))
    expect(nav.mock.calls).toEqual([['back'], ['reload']])
    expect((screen.getByRole('button', { name: TOOLBAR_TEXT.forward }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('swaps reload for stop while loading', () => {
    const { nav } = setup(st({ loading: true }))
    expect(screen.queryByRole('button', { name: TOOLBAR_TEXT.reload })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.stop }))
    expect(nav).toHaveBeenCalledWith('stop')
  })

  it('toggles agent control, and disables the toggle when the server has it off', () => {
    const { onAgentControl } = setup()
    fireEvent.click(screen.getByLabelText(TOOLBAR_TEXT.agentControl))
    expect(onAgentControl).toHaveBeenCalledWith(true)
    cleanup()
    setup(st(), { agentEnabled: false })
    expect((screen.getByLabelText(TOOLBAR_TEXT.agentControl) as HTMLInputElement).disabled).toBe(true)
  })

  it('follows page navigation in the address box', () => {
    const nav = vi.fn()
    const props = { nav, agentControl: false, agentEnabled: true, onAgentControl: vi.fn() }
    const { rerender } = render(<BrowserToolbar state={st()} {...props} />)
    rerender(<BrowserToolbar state={st({ url: 'https://c.com/' })} {...props} />)
    expect(address().value).toBe('https://c.com/')
  })
})

describe('BrowserToolbar zoom', () => {
  it('shows the percent and reports step direction, and is absent without onZoom', () => {
    const onZoom = vi.fn()
    setup(st(), { zoom: 1.2, onZoom })
    expect(screen.getByRole('group', { name: ZOOM_TEXT.level }).textContent).toContain('120%')
    fireEvent.click(screen.getByRole('button', { name: ZOOM_TEXT.out }))
    fireEvent.click(screen.getByRole('button', { name: ZOOM_TEXT.in }))
    expect(onZoom.mock.calls).toEqual([[-1], [1]])
    cleanup()
    setup()
    expect(screen.queryByRole('group', { name: ZOOM_TEXT.level })).toBeNull()
  })
})

describe('BrowserLeaseChip', () => {
  it('shows Stop while the agent drives and calls takeover', () => {
    const onTakeover = vi.fn()
    render(<BrowserLeaseChip lease="agent" onTakeover={onTakeover} />)
    expect(screen.getByRole('status').textContent).toContain(CHIP_TEXT.driving)
    fireEvent.click(screen.getByRole('button', { name: CHIP_TEXT.stopLabel }))
    expect(onTakeover).toHaveBeenCalledTimes(1)
  })

  it.each(['human', undefined] as const)('renders nothing for lease %s', (lease) => {
    const { container } = render(<BrowserLeaseChip lease={lease} onTakeover={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
