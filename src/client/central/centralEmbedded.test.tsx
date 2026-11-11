/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../vscode/test-setup'
import CentralControlPanel from './CentralControlPanel'
import { fakeClient } from './centralFixtures.testutil'

afterEach(cleanup)

describe('CentralControlPanel body', () => {
  it('renders no surface, exposes the 6 sub-nav items and switches sections', async () => {
    const { container } = render(<CentralControlPanel open enabled client={fakeClient()} />)
    expect(container.querySelector('.vscode-bottom-panel')).toBeNull()
    const nav = screen.getByRole('tablist', { name: 'Central control sections' })
    expect(within(nav).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Status', 'Abilities', 'Agents', 'Skills', 'Memory', 'Health'])
    expect(await screen.findByText('What Central may do')).toBeTruthy()
    fireEvent.mouseDown(within(nav).getByRole('tab', { name: 'Abilities' }), { button: 0 })
    expect(await screen.findByText('Projects & nodes (2)')).toBeTruthy()
    expect(screen.queryByText('What Central may do')).toBeNull()
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
