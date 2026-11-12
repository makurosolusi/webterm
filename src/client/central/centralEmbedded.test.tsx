/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../vscode/test-setup'
import CentralControlPanel from './CentralControlPanel'
import { fakeClient } from './centralFixtures.testutil'
import { TAB_REVEAL_MARGIN } from './centralTabStrip.reveal'

afterEach(cleanup)

describe('CentralControlPanel body', () => {
  it('renders no surface, exposes the 7 sub-nav items (Spending hidden) and switches sections', async () => {
    const { container } = render(<CentralControlPanel open enabled client={fakeClient()} />)
    expect(container.querySelector('.vscode-bottom-panel')).toBeNull()
    const nav = screen.getByRole('tablist', { name: 'Central control sections' })
    expect(within(nav).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Status', 'Abilities', 'Agents', 'Skills', 'Memory', 'Automations', 'Health'])
    expect(await screen.findByText('What Central may do')).toBeTruthy()
    fireEvent.mouseDown(within(nav).getByRole('tab', { name: 'Abilities' }), { button: 0 })
    expect(await screen.findByText('Projects & nodes (2)')).toBeTruthy()
    expect(screen.queryByText('What Central may do')).toBeNull()
  })

  it('pins the tab list outside the scrolling body', () => {
    const { container } = render(<CentralControlPanel open enabled client={fakeClient()} tab="health" />)
    const panel = container.querySelector('.ccp-panel') as HTMLElement
    const scroll = screen.getByTestId('ccp-scroll')
    const nav = screen.getByRole('tablist', { name: 'Central control sections' })
    expect(scroll.contains(nav)).toBe(false)
    expect(scroll.parentElement).toBe(panel)
    // Header first, then the content element that scrolls (sections render inside it).
    expect(nav.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(scroll.querySelector('.ccp-section-host')).toBeTruthy()
    expect(nav.className).toContain('ccp-tabs__list')
  })

  describe('narrow strip (tabs overflow)', () => {
    // test-only layout: jsdom has none. A 200px strip whose 7 tabs are 70px each (490px of content).
    let width = 200
    const scrollLeft = new WeakMap<Element, number>()
    const protos: [object, string, PropertyDescriptor | undefined][] = []
    const stub = (proto: object, key: string, desc: PropertyDescriptor): void => {
      protos.push([proto, key, Object.getOwnPropertyDescriptor(proto, key)])
      Object.defineProperty(proto, key, { configurable: true, ...desc })
    }
    const isList = (el: Element): boolean => el.getAttribute('role') === 'tablist'
    beforeEach(() => {
      width = 200
      stub(Element.prototype, 'scrollLeft', { get(this: Element) { return scrollLeft.get(this) ?? 0 }, set(this: Element, v: number) { scrollLeft.set(this, Math.max(0, Math.min(v, 490 - width))) } }) // clamped like browsers
      stub(Element.prototype, 'clientWidth', { get(this: Element) { return isList(this) ? width : 0 } })
      stub(Element.prototype, 'scrollWidth', { get(this: Element) { return isList(this) ? 490 : 0 } })
      stub(Element.prototype, 'getBoundingClientRect', { value(this: Element) {
        const list = this.closest('[role="tablist"]')
        const at = (left: number, w: number) => ({ left, right: left + w, width: w, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
        if (this === list) return at(0, width)
        if (list && this.getAttribute('role') === 'tab') {
          const i = [...list.querySelectorAll('[role="tab"]')].indexOf(this)
          return at(i * 70 - (scrollLeft.get(list) ?? 0), 70)
        }
        return at(0, 0)
      } })
    })
    afterEach(() => { for (const [proto, key, desc] of protos.splice(0).reverse()) { if (desc) Object.defineProperty(proto, key, desc); else delete (proto as Record<string, unknown>)[key] } })

    it('on mount the active tab is scrolled fully into view with a margin, and the cut-off edges are marked', () => {
      render(<CentralControlPanel open enabled client={fakeClient()} tab="automations" />)
      const nav = screen.getByRole('tablist', { name: 'Central control sections' })
      // Automations is tab 6 (350..420): its right edge lands TAB_REVEAL_MARGIN inside the 200px strip.
      expect(nav.scrollLeft).toBe(420 - (200 - TAB_REVEAL_MARGIN))
      const r = within(nav).getByRole('tab', { name: 'Automations' }).getBoundingClientRect()
      expect(r.left).toBeGreaterThanOrEqual(0)
      expect(r.right).toBeLessThanOrEqual(200 - TAB_REVEAL_MARGIN)
      expect(nav.dataset.overflow).toBe('both') // tabs hidden on both sides: both edges fade
    })

    it('mounted hidden (zero width, behind Chat), it reveals the active tab once the strip gets a size', () => {
      width = 0
      render(<CentralControlPanel open enabled client={fakeClient()} tab="health" />)
      const nav = screen.getByRole('tablist', { name: 'Central control sections' })
      expect(nav.scrollLeft).toBe(0)
      width = 200
      fireEvent(window, new Event('resize')) // ResizeObserver in browsers; jsdom has none
      expect(nav.scrollLeft).toBe(490 - 200) // Health is last: scrolled to the end, fully visible
      expect(nav.dataset.overflow).toBe('start')
    })

    it('a wide strip has no overflow mark', () => {
      width = 600
      render(<CentralControlPanel open enabled client={fakeClient()} tab="status" />)
      const nav = screen.getByRole('tablist', { name: 'Central control sections' })
      expect(nav.scrollLeft).toBe(0)
      expect(nav.dataset.overflow).toBeUndefined()
    })
  })

  it('portals the refresh control into actionsHost', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { container } = render(<CentralControlPanel open enabled client={fakeClient()} actionsHost={host} />)
    expect(within(host).getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(container.querySelector('button[aria-label="Refresh"]')).toBeNull()
    host.remove()
  })
})
