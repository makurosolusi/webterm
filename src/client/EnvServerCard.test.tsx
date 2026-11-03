/**
 * @vitest-environment jsdom
 */
// Kartu Info server: status tanpa nilai rahasia + satu penjelasan P-13 bila gerbang root mati.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvServerCard } from './EnvServerCard'

afterEach(cleanup)

describe('EnvServerCard', () => {
  it('shows token set and settings open, no explanation when the root gate is on', () => {
    render(<EnvServerCard server={{ tokenSet: true, settingsLocked: false }} rootGate />)
    expect(screen.getByRole('region', { name: 'Info server' })).toBeTruthy()
    expect(screen.getByText('Token root').nextElementSibling?.textContent).toBe('Terisi')
    expect(screen.getByText('Pengaturan').nextElementSibling?.textContent).toBe('Terbuka')
    expect(screen.queryByText(/butuh WEBTERM_TOKEN/)).toBeNull()
  })

  it('shows empty token, locked settings and exactly one root-gate explanation', () => {
    render(<EnvServerCard server={{ tokenSet: false, settingsLocked: true }} rootGate={false} />)
    expect(screen.getByText('Token root').nextElementSibling?.textContent).toBe('Kosong')
    expect(screen.getByText('Pengaturan').nextElementSibling?.textContent).toBe('Terkunci')
    expect(screen.getAllByText(/butuh WEBTERM_TOKEN/)).toHaveLength(1)
  })
})
