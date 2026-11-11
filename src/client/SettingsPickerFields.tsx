// Settings fields that avoid typing: stepper, slider, number select, and the combobox field (presets
// + remembered values) for what still needs free input. Bounds come from `SETTING_RANGES`.
import type { ReactNode } from 'react'
import type { Settings } from '../shared/settings'
import { SETTING_RANGES, type RangedKey } from '../shared/settings.ranges'
import { SettingsSelect } from './SettingsControls'
import { Field, lockReasonId } from './SettingsFields'
import type { Lock } from '@/components/ui/disabled-reason'
import { SettingsCombobox, type SettingsComboboxProps } from './SettingsCombobox'
import './settings-pickers.css'

interface Base { id: string; label: string; hint?: ReactNode; setting?: keyof Settings }

/** Rounds away float noise from repeated `step` additions (0.1 + 0.2). */
const roundTo = (v: number, step: number): number => {
  const decimals = (String(step).split('.')[1] ?? '').length
  return Number(v.toFixed(decimals))
}

const bounds = (range: RangedKey) => SETTING_RANGES[range]

/** − value + buttons; arrow keys on the value step too. */
export function StepperField({ id, label, hint, setting, range, value, unit, onChange, lock }: Base & {
  range: RangedKey; value: number; unit?: string; onChange(v: number): void; lock?: Lock
}): React.JSX.Element | null {
  const { min, max, step } = bounds(range)
  const set = (v: number): void => { const n = roundTo(Math.min(max, Math.max(min, v)), step); if (!lock && n !== value) onChange(n) }
  const describedBy = lock ? lockReasonId(id) : undefined
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting} lock={lock}>
      <span className="st-stepper" data-control="stepper">
        <button type="button" className="st-button" aria-label={`Decrease ${label}`} aria-describedby={describedBy} disabled={!!lock || value <= min} onClick={() => set(value - step)}>−</button>
        <span id={id} role="spinbutton" tabIndex={0} className="st-stepper-value" aria-label={label} aria-disabled={lock ? true : undefined} aria-describedby={describedBy}
          aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} aria-valuetext={unit ? `${value} ${unit}` : String(value)}
          onKeyDown={(e) => {
            const d = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 10, PageDown: -step * 10 }[e.key]
            if (d !== undefined) { e.preventDefault(); set(value + d) }
            else if (e.key === 'Home') { e.preventDefault(); set(min) }
            else if (e.key === 'End') { e.preventDefault(); set(max) }
          }}>{value}</span>
        <button type="button" className="st-button" aria-label={`Increase ${label}`} aria-describedby={describedBy} disabled={!!lock || value >= max} onClick={() => set(value + step)}>+</button>
        {unit ? <span className="st-unit">{unit}</span> : null}
      </span>
    </Field>
  )
}

/** Native range input with the current value beside it. */
export function SliderField({ id, label, hint, setting, range, value, unit, onChange }: Base & {
  range: RangedKey; value: number; unit?: string; onChange(v: number): void
}): React.JSX.Element | null {
  const { min, max, step } = bounds(range)
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
      <span className="st-slider" data-control="slider">
        <input id={id} type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(roundTo(Number(e.target.value), step))} />
        <output htmlFor={id}>{unit ? `${value} ${unit}` : value}</output>
      </span>
    </Field>
  )
}

/** A select over fixed numbers; a current value not in the list (hand-edited) stays selectable. */
export function NumberSelectField({ id, label, hint, setting, value, options, onChange }: Base & {
  value: number; options: readonly { value: number; label: string }[]; onChange(v: number): void
}): React.JSX.Element | null {
  const list = options.some((o) => o.value === value) ? options : [...options, { value, label: String(value) }]
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
      <SettingsSelect id={id} value={String(value)} options={list.map((o) => ({ value: String(o.value), label: o.label }))}
        onChange={(v) => onChange(Number(v))} />
    </Field>
  )
}

/** `SettingsCombobox` inside a settings `Field`. */
export function ComboboxField({ id, label, hint, setting, ...combo }: Base & Omit<SettingsComboboxProps, 'id' | 'ariaLabel'>): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
      <SettingsCombobox id={id} ariaLabel={label} {...combo} />
    </Field>
  )
}

/** Validator for a whole number in `[min, max]`, for numeric comboboxes. */
export const integerIn = (min: number, max: number, what: string) => (v: string): string | null => {
  const n = Number(v)
  return v !== '' && Number.isInteger(n) && n >= min && n <= max ? null : `Enter ${what} between ${min} and ${max}.`
}
