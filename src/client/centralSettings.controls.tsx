// The two no-typing controls Settings › Central Agent needs beyond Switch/Select: a stepper and a
// segmented choice. Presentational; the section owns loading, saving and disabled reasons.
import { Button } from '@/components/ui/button'
import { CENTRAL_TEXT } from './centralSettingsLabels'
import type { CentralOption } from './centralSettings.registry'

/** − value unit +, clamped to [min, max]; each click commits one step. */
export function Stepper({ id, label, value, min, max, step, unit, disabled, onChange }: {
  id: string; label: string; value: number; min: number; max: number; step: number; unit?: string
  disabled?: boolean; onChange(next: number): void
}): React.JSX.Element {
  const go = (delta: number): void => onChange(Math.min(max, Math.max(min, value + delta)))
  return (
    <span className="inline-flex items-center gap-2" data-stepper={id}>
      <Button size="xs" variant="outline" aria-label={CENTRAL_TEXT.decrease(label)} disabled={disabled || value <= min} onClick={() => go(-step)}>−</Button>
      <output id={id} aria-label={label} className="min-w-12 text-center text-[13px] tabular-nums">{value}{unit ? ` ${unit}` : ''}</output>
      <Button size="xs" variant="outline" aria-label={CENTRAL_TEXT.increase(label)} disabled={disabled || value >= max} onClick={() => go(step)}>+</Button>
    </span>
  )
}

/** One-of-N buttons (radiogroup); an option with `confirm` asks first, a refused dialog changes nothing. */
export function Segmented({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: readonly CentralOption[]; disabled?: boolean; onChange(next: string): void
}): React.JSX.Element {
  const pick = (o: CentralOption): void => {
    if (o.value === value) return
    if (o.confirm && !window.confirm(o.confirm)) return
    onChange(o.value)
  }
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1">
      {options.map((o) => (
        <Button key={o.value} size="xs" role="radio" aria-checked={o.value === value} disabled={disabled}
          variant={o.value === value ? 'default' : 'outline'} onClick={() => pick(o)}>{o.label}</Button>
      ))}
    </span>
  )
}
