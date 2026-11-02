// Kontrol nilai non-secret per kind: flag = checkbox, enum = dropdown native, number/string = input teks.
import { Input } from '@/components/ui/input'
import { SettingsCheckbox, SettingsSelect } from './SettingsControls'
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

/** Checkbox untuk flag (on/off), dropdown untuk enum (options), input untuk number/string. */
export function EnvValueControl({ entry, value, disabled, onChange }: Props): React.JSX.Element {
  if (entry.kind === 'flag') {
    return (
      <SettingsCheckbox ariaLabel={envAriaName(entry)} checked={value === ENV.on} disabled={disabled}
        onChange={(on) => onChange(on ? ENV.on : ENV.off)} />
    )
  }
  if (entry.kind === 'enum') {
    return (
      <SettingsSelect ariaLabel={envAriaName(entry)} value={value} disabled={disabled} onChange={onChange}
        options={(entry.options ?? []).map((c) => ({ value: c, label: c }))} />
    )
  }
  return (
    <Input className="st-input st-mono" type="text" inputMode={entry.kind === 'number' ? 'decimal' : undefined}
      aria-label={envAriaName(entry)} placeholder={entry.default ?? ''} value={value} disabled={disabled}
      onChange={(e) => onChange(e.target.value)} />
  )
}
