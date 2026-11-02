/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { portalContainer } from './portalContainer'
import { VscodeMenu } from './vscodeMenu'
import { VscodeNotification } from './vscodeNotification'
import { VscodePopover } from './vscodePopover'
import { VscodeTooltip } from './vscodeTooltip'

let fsEl: Element | null = null
const setFullscreen = (el: Element | null) => {
  fsEl = el
  act(() => { document.dispatchEvent(new Event('fullscreenchange')) })
}
let host: HTMLElement

beforeEach(() => {
  fsEl = null
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl })
  host = document.createElement('div'); host.className = 'react-flow__node'; document.body.appendChild(host)
})
afterEach(() => { cleanup(); host.remove() })

const items = [{ type: 'item' as const, id: 'a', label: 'Refresh view', onSelect: () => {} }]
const noop = () => {}

describe('portalContainer', () => {
  it('is body without fullscreen and the fullscreen element with it, computed per call', () => {
    expect(portalContainer()).toBe(document.body)
    fsEl = host
    expect(portalContainer()).toBe(host)
  })
})

describe('overlay primitives portal into the fullscreen element', () => {
  it.each([
    ['menu', () => <VscodeMenu open anchor={{ x: 1, y: 1 }} items={items} onClose={noop} />, '[data-slot="vscode-menu"]'],
    ['popover', () => <VscodePopover open anchor={new DOMRect()} onOpenChange={noop}>x</VscodePopover>, '[data-slot="vscode-popover"]'],
    ['notification', () => <VscodeNotification id="n" severity="info" title="t" message="hi" onClose={noop} />, '[data-slot="vscode-notification-stack"]'],
  ])('%s lands in body normally and in the fullscreen element when one is active', (_n, ui, sel) => {
    const a = render(ui())
    expect(document.body.querySelector(`:scope > ${sel}`)).not.toBeNull()
    a.unmount()
    fsEl = host
    render(ui())
    expect(host.querySelector(sel)).not.toBeNull()
    expect(document.body.querySelector(`:scope > ${sel}`)).toBeNull()
  })

  it('tooltip lands in the fullscreen element', () => {
    fsEl = host
    render(<VscodeTooltip content="tip"><button>t</button></VscodeTooltip>)
    fireEvent.focus(screen.getByText('t'))
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
  })
})

describe('transient overlays close when fullscreen toggles', () => {
  it('closes an open menu and popover on fullscreenchange', () => {
    const onClose = vi.fn(); const onOpen = vi.fn()
    render(<>
      <VscodeMenu open anchor={{ x: 1, y: 1 }} items={items} onClose={onClose} />
      <VscodePopover open anchor={new DOMRect()} onOpenChange={onOpen}>x</VscodePopover>
    </>)
    setFullscreen(host)
    expect(onClose).toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledWith(false)
  })

  it('hides a visible tooltip on fullscreenchange', () => {
    render(<VscodeTooltip content="tip"><button>t</button></VscodeTooltip>)
    fireEvent.focus(screen.getByText('t'))
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
    setFullscreen(host)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('moves the toast stack into the fullscreen element and back', () => {
    render(<VscodeNotification id="n" severity="warning" title="t" message="keep" onClose={noop} />)
    setFullscreen(host)
    expect(host.querySelector('[data-slot="vscode-notification-stack"]')).not.toBeNull()
    setFullscreen(null)
    expect(host.querySelector('[data-slot="vscode-notification-stack"]')).toBeNull()
    expect(document.body.querySelector(':scope > [data-slot="vscode-notification-stack"]')).not.toBeNull()
  })

  it('a controlled menu stays closed state-wise after fullscreen closes it', () => {
    function H() { const [o, s] = useState(true); return <VscodeMenu open={o} anchor={{ x: 1, y: 1 }} items={items} onClose={() => s(false)} /> }
    render(<H />)
    setFullscreen(host)
    expect(document.querySelector('[data-slot="vscode-menu"]')).toBeNull()
  })
})
