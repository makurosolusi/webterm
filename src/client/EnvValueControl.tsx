// Kontrol nilai non-secret per kind: flag/enum = radio, number/string = input teks.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ENV } from './envLabels'
import type { EnvEntry } from './envSettingsApi'

interface Props {
  entry: EnvEntry
  value: string
  disabled: boolean
  onChange: (value: string) => void
}

/** Nama aksesibel kontrol: label + KEY. */
export const envAriaName = (e: EnvEntry): string => `${e.label} (${e.key})`

/** Radio untuk flag (on/off) dan enum (options); input untuk number/string. */
export function EnvValueControl({ entry, value, disabled, onChange }: Props): React.JSX.Element {
  const choices = entry.kind === 'flag' ? [ENV.on, ENV.off] : entry.kind === 'enum' ? (entry.options ?? []) : null
  if (choices) {
    return (
      <div role="radiogroup" aria-label={envAriaName(entry)} className="st-chips">
        {choices.map((c) => (
          <Button key={c} type="button" role="radio" aria-checked={value === c} variant="outline" size="sm" disabled={disabled}
            className={'st-button' + (value === c ? ' is-active' : '')} onClick={() => onChange(c)}>
            {c}
          </Button>
        ))}
      </div>
    )
  }
  return (
    <Input className="st-input st-mono" type="text" inputMode={entry.kind === 'number' ? 'decimal' : undefined}
      aria-label={envAriaName(entry)} placeholder={entry.default ?? ''} value={value} disabled={disabled}
      onChange={(e) => onChange(e.target.value)} />
  )
}
