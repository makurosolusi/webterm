/** @vitest-environment jsdom */
// Browser UI standards (docs/decisions/browser-ui-standards.md): every toolbar action is reachable by name, controls use
// the 28px browser sizes, and what a narrow node hides by container query is still offered in the ⋮ menu.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState } from '../shared/browser.contract'
import BrowserToolbar from './BrowserToolbar'
import { TOOLBAR_MENU_TEXT as M, TOOLBAR_TEXT, ZOOM_TEXT } from './browser.uxText'
import { CONSOLE_TEXT } from './BrowserConsole'

afterEach(cleanup)
const state: BrowserState = { id: 'n1', url: 'https://a.com/', title: '', loading: false, canBack: true, canForward: true, lease: 'human', live: 'live', shieldsOff: false }

function setup() {
  render(
    <BrowserToolbar
      state={state} nav={vi.fn()} agentControl agentEnabled onAgentControl={vi.fn()} zoom={1.25} onZoom={vi.fn()} onShields={vi.fn()}
      device={undefined} onDevice={vi.fn()} console={{ open: false, errors: 2, toggle: vi.fn() }}
      design={{ on: false, busy: false, error: null, toggle: vi.fn() } as never}
    />,
  )
}

describe('BrowserToolbar standards', () => {
  it('offers every action as a named control (toolbar row)', () => {
    setup()
    for (const name of [TOOLBAR_TEXT.back, TOOLBAR_TEXT.forward, TOOLBAR_TEXT.reload, TOOLBAR_TEXT.agentPill, TOOLBAR_TEXT.more]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByLabelText(TOOLBAR_TEXT.urlLabel)).toBeTruthy()
    expect(screen.getByRole('button', { name: CONSOLE_TEXT.errors(2) })).toBeTruthy()
    expect(screen.getByRole('button', { name: ZOOM_TEXT.pill('125%') })).toBeTruthy()
  })

  it('uses the 28px browser sizes, never xs', () => {
    setup()
    const sizes = Array.from(document.querySelectorAll('.browser-toolbar button')).map((b) => b.getAttribute('data-size'))
    expect(sizes.length).toBeGreaterThan(4)
    for (const s of sizes) expect(['icon-bui', 'bui']).toContain(s)
  })

  it('keeps what narrow nodes hide (agent toggle, zoom, shields, console, device, design) reachable in the ⋮ menu', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: TOOLBAR_TEXT.more }))
    for (const name of [TOOLBAR_TEXT.agentControl, M.shields, M.design, M.device, CONSOLE_TEXT.toggle, ZOOM_TEXT.in, ZOOM_TEXT.out]) {
      expect(screen.queryByRole('menuitem', { name }) ?? screen.getByRole('menuitemcheckbox', { name })).toBeTruthy()
    }
  })

  it('tabs in visual order: back, forward, reload, address', () => {
    setup()
    const order = Array.from(document.querySelectorAll<HTMLElement>('.browser-toolbar button, .browser-toolbar input')).map((e) => e.getAttribute('aria-label'))
    expect(order.slice(0, 3)).toEqual([TOOLBAR_TEXT.back, TOOLBAR_TEXT.forward, TOOLBAR_TEXT.reload])
    expect(order.indexOf(TOOLBAR_TEXT.urlLabel)).toBe(3)
  })
})
