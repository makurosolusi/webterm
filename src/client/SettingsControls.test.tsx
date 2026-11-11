/** @vitest-environment jsdom */
// SettingsSelect never renders blank: a stored value outside `options` shows as a disabled "(not in list)" option.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSelect } from './SettingsControls'

afterEach(cleanup)
const OPTIONS = [{ value: 'a', label: 'A' }] as const // test-only

describe('SettingsSelect', () => {
  it('shows a stored value that is not among the options', () => {
    render(<SettingsSelect<string> ariaLabel="Pick" value="bogus" options={OPTIONS} onChange={vi.fn()} />)
    const select = screen.getByLabelText('Pick') as HTMLSelectElement
    expect(select.selectedOptions[0]?.textContent).toContain('bogus')
    expect(select.selectedOptions[0]?.disabled).toBe(true)
  })

  it('adds nothing when the value is listed', () => {
    render(<SettingsSelect ariaLabel="Pick" value="a" options={OPTIONS} onChange={vi.fn()} />)
    const select = screen.getByLabelText('Pick') as HTMLSelectElement
    expect(select.options).toHaveLength(1)
    expect(select.selectedOptions[0]?.textContent).toBe('A')
  })
})
