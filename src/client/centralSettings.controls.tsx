// The two no-typing controls Settings › Central needs beyond Switch/Select: a stepper (same look and keys
// as StepperField, but over an env value instead of a Settings key) and the level choice (the shared
// SettingsSegmented; an option with `confirm` asks in the app AlertDialog first). Presentational; the
// section owns loading, saving and disabled reasons.
import { useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { CENTRAL_TEXT } from './centralSettingsLabels'
import type { CentralOption } from './centralSettings.registry'
import { SettingsSegmented } from './SettingsControls'
import { formatNumber } from './SettingsPickerFields'

/** − value unit +, clamped to [min, max]; each click or arrow key commits one step. */
export function Stepper({ id, label, value, min, max, step, unit, disabled, describedBy, onChange }: {
  id: string; label: string; value: number; min: number; max: number; step: number; unit?: string
  disabled?: boolean; describedBy?: string; onChange(next: number): void
}): React.JSX.Element {
  const go = (next: number): void => {
    const n = Math.min(max, Math.max(min, next))
    if (!disabled && n !== value) onChange(n)
  }
  const text = formatNumber(value, 1, unit)
  return (
    <span className="st-stepper" data-control="stepper" data-stepper={id}>
      <Button size="xs" variant="outline" aria-label={CENTRAL_TEXT.decrease(label)} aria-describedby={describedBy}
        disabled={disabled || value <= min} onClick={() => go(value - step)}>−</Button>
      <span id={id} role="spinbutton" tabIndex={disabled ? -1 : 0} className="st-stepper-value" aria-label={label}
        aria-disabled={disabled || undefined} aria-describedby={describedBy}
        aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} aria-valuetext={text}
        onKeyDown={(e) => {
          const d = ({ ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step } as Record<string, number>)[e.key]
          if (d !== undefined) { e.preventDefault(); go(value + d) }
          else if (e.key === 'Home') { e.preventDefault(); go(min) }
          else if (e.key === 'End') { e.preventDefault(); go(max) }
        }}>{text}</span>
      <Button size="xs" variant="outline" aria-label={CENTRAL_TEXT.increase(label)} aria-describedby={describedBy}
        disabled={disabled || value >= max} onClick={() => go(value + step)}>+</Button>
    </span>
  )
}

/** One-of-few choice; an option with `confirm` opens the AlertDialog, and Cancel changes nothing. */
export function LevelChoice({ id, label, value, options, disabled, describedBy, onChange }: {
  id: string; label: string; value: string; options: readonly CentralOption[]; disabled?: boolean; describedBy?: string
  onChange(next: string): void
}): React.JSX.Element {
  const [asking, setAsking] = useState<CentralOption | null>(null)
  const pick = (next: string): void => {
    const o = options.find((x) => x.value === next)
    if (!o) return
    if (o.confirm) setAsking(o)
    else onChange(o.value)
  }
  return (
    <>
      <SettingsSegmented id={id} ariaLabel={label} value={value} options={options} disabled={disabled} describedBy={describedBy} onChange={pick} />
      {asking?.confirm ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setAsking(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{asking.confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{asking.confirm.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{CENTRAL_TEXT.cancel}</AlertDialogCancel>
              <AlertDialogAction onClick={() => onChange(asking.value)}>{asking.confirm.action}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  )
}

/** @deprecated Older callers (Policy rules, simulator, eval cases): the shared SettingsSegmented under the
 *  old props. New code uses SettingsSegmented / SegmentedField directly; drop this once those move. */
export function Segmented({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: readonly { value: string; label: string }[]; disabled?: boolean; onChange(next: string): void
}): React.JSX.Element {
  return <SettingsSegmented ariaLabel={label} value={value} options={options} disabled={disabled} onChange={onChange} />
}
