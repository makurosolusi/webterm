/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../vscode/test-setup'
import CentralControlPanel from './CentralControlPanel'
import { fakeClient } from './centralFixtures.testutil'

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

  it('pins the tab list outside the scrolling body and keeps the active tab in view', () => {
    const scrolled: Element[] = []
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    try {
      const { container } = render(<CentralControlPanel open enabled client={fakeClient()} tab="health" />)
      const panel = container.querySelector('.ccp-panel') as HTMLElement
      const scroll = screen.getByTestId('ccp-scroll')
      const nav = screen.getByRole('tablist', { name: 'Central control sections' })
      expect(scroll.contains(nav)).toBe(false)
      expect(scroll.parentElement).toBe(panel)
      // Header first, then the content element that scrolls (sections render inside it).
      expect(nav.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(scroll.querySelector('.ccp-section-host')).toBeTruthy()
      // Overflowing tabs scroll inside the strip; the last (active) tab was scrolled into view.
      expect(nav.className).toContain('ccp-tabs__list')
      expect(scrolled.at(-1)?.textContent).toBe('Health')
    } finally {
      Element.prototype.scrollIntoView = orig
    }
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
