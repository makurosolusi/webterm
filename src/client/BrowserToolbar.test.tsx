/** @vitest-environment jsdom */
// Toolbar + lease chip: URL validation (Enter submits, no Go button), nav buttons, address-field extras, ⋯ menu, lease chip.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState } from '../shared/browser.contract'
import BrowserLeaseChip from './BrowserLeaseChip'
import BrowserToolbar from './BrowserToolbar'
import { AGENT_OFFER_TEXT, CHIP_TEXT, SITE_INFO_TEXT, TOOLBAR_MENU_TEXT, TOOLBAR_TEXT, URL_ERROR_TEXT, ZOOM_TEXT } from './browser.uxText'
import { CONSOLE_TEXT } from './BrowserConsole'
import { DEVICE_TEXT } from './browser.device'
import { RECENT_STORAGE_KEY } from './browser.recent'

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
const st = (o: Partial<BrowserState> = {}): BrowserState =>
  ({ id: 'n1', url: 'https://a.com/', title: '', loading: false, canBack: true, canForward: false, lease: 'human', live: 'live', ...o })

function setup(state: BrowserState | undefined = st(), extra: Partial<Parameters<typeof BrowserToolbar>[0]> = {}) {
  const nav = vi.fn(); const onAgentControl = vi.fn()
  render(<BrowserToolbar state={state} nav={nav} agentControl={false} agentEnabled onAgentControl={onAgentControl} {...extra} />)
  return { nav, onAgentControl }
}
const address = () => screen.getByLabelText(TOOLBAR_TEXT.urlLabel) as HTMLInputElement
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.more }))
/** Opens ⋯ and picks a row by its accessible name (plain or checkbox row). */
const pick = (name: string) => {
  openMenu()
  fireEvent.click(screen.queryByRole('menuitem', { name }) ?? screen.getByRole('menuitemcheckbox', { name }))
}

describe('BrowserToolbar', () => {
  it('shows the current url, navigates on Enter and has no Go button', () => {
    const { nav } = setup()
    expect(address().value).toBe('https://a.com/')
    expect(address().hasAttribute('data-browser-omnibox')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull()
    fireEvent.change(address(), { target: { value: ' https://b.com/x?q=1 ' } })
    // jsdom does not turn Enter into an implicit submit; the form's submit event is what Enter fires in a browser.
    fireEvent.keyDown(address(), { key: 'Enter' })
    fireEvent.submit(address().closest('form')!)
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

  it('toggles agent control from the ⋯ menu, and the pill turns it off', () => {
    const { onAgentControl } = setup()
    expect(screen.queryByRole('button', { name: TOOLBAR_TEXT.agentPill })).toBeNull() // off: no pill
    pick(TOOLBAR_TEXT.agentControl)
    expect(onAgentControl).toHaveBeenCalledExactlyOnceWith(true)
    cleanup()
    const on = setup(st(), { agentControl: true })
    openMenu()
    expect(screen.getByRole('menuitemcheckbox', { name: TOOLBAR_TEXT.agentControl }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.agentPill }))
    expect(on.onAgentControl).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('hides the Agents pill while an agent actually drives (the lease chip says so)', () => {
    setup(st({ lease: 'agent' }), { agentControl: true })
    expect(screen.queryByRole('button', { name: TOOLBAR_TEXT.agentPill })).toBeNull()
  })

  it('server off: no dead toggle, an offer that asks for confirmation before enabling', async () => {
    const onEnableAgent = vi.fn(async () => undefined)
    setup(st(), { agentEnabled: false, onEnableAgent })
    openMenu()
    expect(screen.queryByRole('menuitemcheckbox', { name: TOOLBAR_TEXT.agentControl })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: TOOLBAR_MENU_TEXT.agentOffer }))
    fireEvent.click(screen.getByRole('button', { name: AGENT_OFFER_TEXT.offer }))
    expect(screen.getByText(AGENT_OFFER_TEXT.warning)).toBeTruthy()
    expect(onEnableAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: AGENT_OFFER_TEXT.cancel }))
    expect(screen.queryByText(AGENT_OFFER_TEXT.warning)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: AGENT_OFFER_TEXT.offer }))
    fireEvent.click(screen.getByRole('button', { name: AGENT_OFFER_TEXT.confirm }))
    expect(onEnableAgent).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText(AGENT_OFFER_TEXT.warning)).toBeNull())
  })

  it('offer keeps the confirmation open with an error when enabling fails', async () => {
    setup(st(), { agentEnabled: false, onEnableAgent: vi.fn(async () => { throw new Error('403') }) })
    pick(TOOLBAR_MENU_TEXT.agentOffer)
    fireEvent.click(screen.getByRole('button', { name: AGENT_OFFER_TEXT.offer }))
    fireEvent.click(screen.getByRole('button', { name: AGENT_OFFER_TEXT.confirm }))
    expect((await screen.findByRole('alert')).textContent).toBe(AGENT_OFFER_TEXT.failed)
    expect(screen.getByText(AGENT_OFFER_TEXT.warning)).toBeTruthy()
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
  it('hides the zoom pill at 100%, shows it otherwise and resets on click', () => {
    const onZoom = vi.fn(); const onZoomReset = vi.fn()
    setup(st(), { zoom: 1, onZoom, onZoomReset })
    expect(screen.queryByRole('button', { name: ZOOM_TEXT.pill('100%') })).toBeNull()
    cleanup()
    setup(st(), { zoom: 1.2, onZoom, onZoomReset })
    const pill = screen.getByRole('button', { name: ZOOM_TEXT.pill('120%') })
    expect(pill.textContent).toBe('120%')
    expect(pill.closest('.browser-omnibox__extra')).not.toBeNull() // hidden by the narrow-toolbar container query
    fireEvent.click(pill)
    expect(onZoomReset).toHaveBeenCalledOnce()
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('without onZoomReset the pill steps back to 100%', () => {
    const onZoom = vi.fn()
    setup(st(), { zoom: 0.7, onZoom })
    fireEvent.click(screen.getByRole('button', { name: ZOOM_TEXT.pill('70%') }))
    expect(onZoom.mock.calls).toEqual([[1], [1], [1]])
  })

  it('⋯ menu zooms out, in and resets (showing the percent); no zoom rows without onZoom', () => {
    const onZoom = vi.fn(); const onZoomReset = vi.fn()
    setup(st(), { zoom: 1.1, onZoom, onZoomReset })
    pick(ZOOM_TEXT.out); pick(ZOOM_TEXT.in); pick(TOOLBAR_MENU_TEXT.zoomReset('110%'))
    expect(onZoom.mock.calls).toEqual([[-1], [1]])
    expect(onZoomReset).toHaveBeenCalledOnce()
    cleanup()
    setup()
    openMenu()
    expect(screen.queryByRole('menuitem', { name: ZOOM_TEXT.in })).toBeNull()
  })
})

describe('BrowserToolbar address field', () => {
  it.each([
    ['https://a.com/', 'secure', 'codicon-lock'],
    ['http://a.com/', 'insecure', 'codicon-warning'],
    ['about:blank', 'other', 'codicon-info'],
  ] as const)('site-info icon for %s', (url, kind, cls) => {
    setup(st({ url }))
    const el = screen.getByRole('img', { name: SITE_INFO_TEXT[kind].label })
    expect(el.classList.contains(cls)).toBe(true)
    expect(el.getAttribute('data-site-info')).toBe(kind)
  })

  it('offers recent pages as native datalist suggestions', () => {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([{ url: 'https://x.dev/docs', host: 'x.dev', title: 'X docs' }, { url: 'https://y.dev/', host: 'y.dev', title: '' }]))
    setup()
    const list = document.getElementById(address().getAttribute('list')!)!
    expect(list.tagName).toBe('DATALIST')
    expect([...list.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([['https://x.dev/docs', 'X docs'], ['https://y.dev/', 'y.dev']])
  })

  it('buttons inside the address form never submit it (Enter must navigate, not reset zoom or flip Shields)', () => {
    // jsdom has no implicit submission; in Chrome, Enter clicks the form's first submit button.
    setup(st({ shieldsOff: false }), { zoom: 1.1, onZoom: vi.fn(), onShields: vi.fn() })
    const form = address().closest('form')!
    expect(form.querySelectorAll('button')).toHaveLength(2)
    expect([...form.querySelectorAll('button')].map((b) => b.getAttribute('type'))).toEqual(['button', 'button'])
  })

  it('Shields chip sits inside the address field and toggles', () => {
    const onShields = vi.fn()
    setup(st({ shieldsOff: false, blockedAds: 3, blockedPopups: 1 }), { onShields })
    const chip = screen.getByRole('button', { name: 'Shields' })
    expect(chip.closest('form.browser-omnibox')).not.toBeNull()
    expect(chip.textContent).toBe('4')
    fireEvent.click(chip)
    expect(onShields).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('narrow-width structure: forward and the in-field extras carry the container-query hooks', () => {
    // jsdom has no container queries: pin the classes browser.css hides at 360px / 260px.
    setup(st({ shieldsOff: false }), { zoom: 1.5, onZoom: vi.fn(), onShields: vi.fn() })
    const bar = screen.getByRole('toolbar', { name: TOOLBAR_TEXT.group })
    expect(bar.classList.contains('browser-toolbar')).toBe(true)
    expect(screen.getByRole('button', { name: TOOLBAR_TEXT.forward }).closest('.browser-toolbar__forward')).not.toBeNull()
    expect(bar.querySelectorAll('.browser-omnibox__extra')).toHaveLength(2)
    expect(bar.querySelector('.browser-toolbar__row')?.children).toHaveLength(5) // one row: back, forward, reload, address field, ⋯
  })
})

describe('BrowserToolbar console badge', () => {
  it('is hidden with no errors, labelled with the count otherwise, and toggles the drawer', () => {
    const toggle = vi.fn()
    setup(st(), { console: { open: false, errors: 0, toggle } })
    expect(screen.queryByRole('button', { name: CONSOLE_TEXT.errors(0) })).toBeNull()
    expect(screen.queryByRole('button', { name: CONSOLE_TEXT.toggle })).toBeNull()
    cleanup()
    setup(st(), { console: { open: false, errors: 20, toggle } })
    const badge = screen.getByRole('button', { name: CONSOLE_TEXT.errors(20) })
    expect(badge.textContent).toBe('20')
    fireEvent.click(badge)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('stays as a close toggle while the drawer is open, and the ⋯ Console row toggles too', () => {
    const toggle = vi.fn()
    setup(st(), { console: { open: true, errors: 0, toggle } })
    expect(screen.getByRole('button', { name: CONSOLE_TEXT.toggle }).getAttribute('aria-pressed')).toBe('true')
    pick(CONSOLE_TEXT.toggle)
    expect(toggle).toHaveBeenCalledOnce()
  })
})

describe('BrowserToolbar ⋯ menu', () => {
  it('device row opens the device picker', () => {
    const onDevice = vi.fn()
    setup(st(), { onDevice })
    pick(TOOLBAR_MENU_TEXT.device)
    fireEvent.click(screen.getByRole('button', { name: DEVICE_TEXT.responsive }))
    expect(onDevice).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('Shields row shows the state and flips it for this site', () => {
    const onShields = vi.fn()
    setup(st({ shieldsOff: true }), { onShields })
    openMenu()
    expect(screen.getByRole('menuitemcheckbox', { name: TOOLBAR_MENU_TEXT.shields }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: TOOLBAR_MENU_TEXT.shields }))
    expect(onShields).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('Design Mode row toggles through the design state', () => {
    const toggle = vi.fn(async () => undefined)
    setup(st(), { design: { on: true, busy: false, error: null, toggle } })
    openMenu()
    expect(screen.getByRole('menuitemcheckbox', { name: TOOLBAR_MENU_TEXT.design }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: TOOLBAR_MENU_TEXT.design }))
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('copies the URL and opens it in the system browser', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    setup()
    pick(TOOLBAR_MENU_TEXT.copyUrl)
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('https://a.com/'))
    pick(TOOLBAR_MENU_TEXT.openExternal)
    expect(open).toHaveBeenCalledExactlyOnceWith('https://a.com/', '_blank', 'noopener')
  })

  it('reports a failed copy in the alert line', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied') }) }, configurable: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setup()
    pick(TOOLBAR_MENU_TEXT.copyUrl)
    expect((await screen.findByRole('alert')).textContent).toBe(TOOLBAR_MENU_TEXT.copyFailed)
  })

  it('is keyboard navigable (arrow keys move between rows)', () => {
    setup(st(), { onZoom: vi.fn(), zoom: 1.2 })
    openMenu()
    const first = document.activeElement as HTMLElement
    expect(first.getAttribute('role')).toMatch(/^menuitem/)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).not.toBe(first)
    expect((document.activeElement as HTMLElement).getAttribute('role')).toMatch(/^menuitem/)
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
