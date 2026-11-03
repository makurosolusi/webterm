// Kontrol nilai non-secret per kind: flag = checkbox, enum = dropdown native, number/string = input teks.
import { Input } from '@/components/ui/input'
import { SettingsCheckbox } from './SettingsControls'
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

/** Teks status nilai enum tak dikenal (Rule 15: bukan literal di JSX). */
const INVALID_NOTE = 'Nilai tidak dikenal, dibaca sebagai bawaan'
const INVALID_MAX = 40
const INVALID_VALUE = '\u0000invalid'

// Cermin flagOn server (trim + lowercase === 'on'); TODO(env-00): ganti dengan flagIsOn dari envSettings.contract saat rebase.
const flagIsOn = (raw: string): boolean => raw.trim().toLowerCase() === ENV.on

/** Checkbox untuk flag (on/off), dropdown untuk enum (options), input untuk number/string. */
export function EnvValueControl({ entry, value, disabled, onChange }: Props): React.JSX.Element {
  if (entry.kind === 'flag') {
    return (
      <SettingsCheckbox ariaLabel={envAriaName(entry)} checked={flagIsOn(value)} disabled={disabled}
        onChange={(on) => onChange(on ? ENV.on : ENV.off)} />
    )
  }
  if (entry.kind === 'enum') {
    const options = entry.options ?? []
    const match = options.find((o) => o.toLowerCase() === value.trim().toLowerCase())
    const invalid = match === undefined && value.trim() !== ''
    const shown = value.length > INVALID_MAX ? `${value.slice(0, INVALID_MAX)}…` : value
    // Select native sendiri (bukan SettingsSelect) karena butuh aria-invalid + opsi tidak sah.
    return (
      <>
        <span className="st-select-wrap">
          <select className="st-select" aria-label={envAriaName(entry)} aria-invalid={invalid || undefined}
            value={invalid ? INVALID_VALUE : (match ?? value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
            {invalid && <option value={INVALID_VALUE}>{`— tidak sah: "${shown}" —`}</option>}
            {options.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="codicon codicon-chevron-down st-select-chevron" aria-hidden="true" />
        </span>
        {invalid && <span className="st-note" role="note">{INVALID_NOTE}</span>}
      </>
    )
  }
  return (
    <Input className="st-input st-mono" type="text" inputMode={entry.kind === 'number' ? 'decimal' : undefined}
      aria-label={envAriaName(entry)} placeholder={entry.default ?? ''} value={value} disabled={disabled}
      onChange={(e) => onChange(e.target.value)} />
  )
}
