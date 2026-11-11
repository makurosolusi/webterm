/** @vitest-environment jsdom */
// Field `lock`: the control is disabled and described by a reason line; the hint is never swapped;
// settings search also matches the reason.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectField, SettingsSearchProvider, ToggleField } from './SettingsFields'
import { StepperField } from './SettingsPickerFields'

afterEach(cleanup)
const LOCK = { reason: 'Locked by Central.' } // test-only
const OPTIONS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] as const // test-only

describe('Field lock', () => {
  it('SelectField / ToggleField / StepperField: disabled, described by the reason, hint kept', () => {
    render(<>
      <SelectField id="s" label="Mode" hint="What the mode does." value="a" options={OPTIONS} onChange={vi.fn()} lock={LOCK} />
      <ToggleField id="t" label="Flag" hint="What the flag does." value onChange={vi.fn()} lock={LOCK} />
      <StepperField id="n" label="Count" hint="How many." range="fontSize" value={14} onChange={vi.fn()} lock={LOCK} />
    </>)
    for (const [label, hint] of [['Mode', 'What the mode does.'], ['Flag', 'What the flag does.']] as const) {
      const control = screen.getByLabelText(label) as HTMLInputElement
      expect(control.disabled).toBe(true)
      expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Locked by Central.')
      expect(screen.getByText(hint)).toBeTruthy()
    }
    expect((screen.getByRole('button', { name: 'Increase Count' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('spinbutton').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('How many.')).toBeTruthy()
  })

  it('search matches the lock reason', () => {
    render(<SettingsSearchProvider query="central">
      <SelectField id="s" label="Mode" hint="What the mode does." value="a" options={OPTIONS} onChange={vi.fn()} lock={LOCK} />
      <SelectField id="u" label="Other" hint="Unrelated." value="a" options={OPTIONS} onChange={vi.fn()} />
    </SettingsSearchProvider>)
    expect(screen.queryByLabelText('Mode')).toBeTruthy()
    expect(screen.queryByLabelText('Other')).toBeNull()
  })
})
