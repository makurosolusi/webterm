/** @vitest-environment jsdom */
// Shared Settings controls: SettingsSelect never renders blank (a stored value outside `options` shows as
// a disabled "(not in list)" option), the segmented radio group, the grouped card and the Advanced collapsible.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsAdvanced, SettingsGroup, SettingsSegmented, SettingsSelect } from './SettingsControls'
import { SegmentedField } from './SettingsFields'
import { formatNumber, SliderField, StepperField } from './SettingsPickerFields'

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

const SHAPES = [{ value: 'block', label: 'Block', glyph: '█' }, { value: 'bar', label: 'Bar' }, { value: 'underline', label: 'Underline' }] as const // test-only

describe('SettingsSegmented', () => {
  it('is a radio group with one tab stop; click and arrow keys select (wrapping), and focus follows', () => {
    const onChange = vi.fn()
    render(<SettingsSegmented ariaLabel="Cursor style" value="bar" options={SHAPES} onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: 'Cursor style' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    expect(radios[0]!.querySelector('.st-seg-glyph')?.textContent).toBe('█')
    fireEvent.click(radios[2]!)
    expect(onChange).toHaveBeenLastCalledWith('underline')
    fireEvent.keyDown(radios[1]!, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('block')
    expect(document.activeElement).toBe(radios[0])
    fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('underline')
    onChange.mockClear()
    fireEvent.click(radios[1]!) // the current option: no change
    expect(onChange).not.toHaveBeenCalled()
  })

  it('SegmentedField puts it in a row, disabled with the lock reason', () => {
    render(<SegmentedField id="seg" label="Cursor style" value="bar" options={SHAPES} onChange={vi.fn()} lock={{ reason: 'Off while X is on.' }} />)
    const group = screen.getByRole('radiogroup', { name: 'Cursor style' })
    expect(group.closest('.st-control')).toBeTruthy()
    expect(group.getAttribute('aria-describedby')).toBe('seg-lock')
    expect(within(group).getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true)
  })
})

describe('SettingsGroup and SettingsAdvanced', () => {
  it('a group is a labelled region: the title above a card holding the rows', () => {
    render(<SettingsGroup title="Look" description="How text looks."><p>row</p></SettingsGroup>)
    const region = screen.getByRole('region', { name: 'Look' })
    expect(region.querySelector('.st-group-card')?.textContent).toBe('row')
    expect(region.querySelector('.st-group-desc')?.textContent).toBe('How text looks.')
  })

  it('Advanced is a closed <details> with a codicon chevron and the row count, rows in a card', () => {
    render(<SettingsAdvanced><p>a</p><p>b</p><p>c</p></SettingsAdvanced>)
    const details = document.querySelector('details.st-advanced') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Advanced · 3')
    expect(details.querySelector('summary .codicon-chevron-right')).toBeTruthy()
    expect(details.querySelector('.st-group-card')?.children).toHaveLength(3)
  })
})

describe('number formatting in pickers', () => {
  it('formatNumber keeps the step decimals, groups thousands and adds the unit', () => {
    expect(formatNumber(1, 0.1)).toBe('1.0')
    expect(formatNumber(12000, 1, 'lines')).toBe('12,000 lines')
    expect(formatNumber(0, 0.5, 'px')).toBe('0.0 px')
  })

  it('a slider shows min and max at its ends, the value in a fixed slot, and a tick at the default', () => {
    render(<SliderField id="lh" setting="terminalLineHeight" label="Line height" range="terminalLineHeight" value={1.2} onChange={vi.fn()} format={(v) => `${v.toFixed(1)}×`} />)
    const slider = screen.getByLabelText('Line height') as HTMLInputElement
    const bounds = [...document.querySelectorAll('.st-slider-bound')].map((b) => b.textContent)
    expect(bounds).toHaveLength(2)
    expect(bounds.every((b) => b?.endsWith('×'))).toBe(true)
    expect(document.querySelector('.st-slider-value')?.textContent).toBe('1.2×')
    expect(slider.getAttribute('aria-valuetext')).toBe('1.2×')
    expect(document.getElementById(slider.getAttribute('list')!)?.querySelector('option')).toBeTruthy()
  })

  it('a stepper formats its value and screen-reader text the same way', () => {
    render(<StepperField id="fs" label="Font size" range="fontSize" value={13} unit="px" onChange={vi.fn()} />)
    const spin = screen.getByRole('spinbutton', { name: 'Font size' })
    expect(spin.textContent).toBe('13')
    expect(spin.getAttribute('aria-valuetext')).toBe('13 px')
  })
})
