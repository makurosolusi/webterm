// Kontrol nilai non-secret per kind: flag/enum on-off = switch, enum = dropdown native, number/string = input teks.
import { Input } from '@/components/ui/input'
import { flagIsOn } from '../shared/envSettings.contract'
import { ENV } from './envLabels'
import type { EnvEntry } from './envSettingsApi'

interface Props {
  entry: EnvEntry
  value: string
  disabled: boolean
  onChange: (value: string) => void
  /** id elemen kontrol, target `<label htmlFor>`; tanpa id kontrol memakai aria-label. */
  id?: string
  /** id elemen yang menjelaskan kontrol (deskripsi, error, dangerNote). */
  describedBy?: string
  /** Tandai aria-invalid (error lokal/server pada baris). */
  invalid?: boolean
}

/** Nama aksesibel kontrol: label + KEY. */
export const envAriaName = (e: EnvEntry): string => `${e.label} (${e.key})`

const INVALID_MAX = 40
const INVALID_VALUE = '\u0000invalid'
const norm = (v: string): string => v.trim().toLowerCase()

/** Enum yang opsinya persis on/off tampil sebagai switch, bukan dropdown. */
export const isSwitch = (e: EnvEntry): boolean =>
  e.kind === 'flag' || (e.kind === 'enum' && e.options?.length === 2 && e.options.every((o) => o === ENV.on || o === ENV.off))

/** Teks rentang/satuan number yang selalu terlihat, mis. "1–60 detik". */
export function rangeText(e: EnvEntry): string {
  const range = e.min !== undefined || e.max !== undefined ? `${e.min ?? ''}–${e.max ?? ''}` : ''
  return [range, e.unit].filter(Boolean).join(' ')
}

/** Validasi lokal draft (number, path absolut, enum); undefined = lolos. Server tetap validator akhir. */
export function localError(e: EnvEntry, value: string): string | undefined {
  const t = value.trim()
  if (e.kind === 'number') {
    if (t === '') return e.allowEmpty ? undefined : ENV.errNumberRequired
    const n = Number(t)
    if (!Number.isFinite(n)) return ENV.errNumber
    if ((e.min !== undefined && n < e.min) || (e.max !== undefined && n > e.max)) return `${ENV.errRange} ${rangeText(e)}.`
  }
  if (e.kind === 'string' && e.absolutePath && t !== '' && !/^(\/|[A-Za-z]:[\\/])/.test(t)) return ENV.errAbsolutePath
  if (e.kind === 'enum' && !isSwitch(e) && t !== '' && !(e.options ?? []).some((o) => norm(o) === norm(t))) return ENV.errEnumPick
  return undefined
}

/** Switch (role=switch) berbasis kotak centang Settings; nilai ditulis on/off kanonik. */
function Switch({ on, ...p }: { on: boolean; id?: string; name: string; disabled: boolean; describedBy?: string; onChange: (on: boolean) => void }): React.JSX.Element {
  return (
    <span className="st-checkbox">
      <input id={p.id} type="checkbox" role="switch" aria-checked={on} aria-label={p.id ? undefined : p.name}
        aria-describedby={p.describedBy} checked={on} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} />
      <span className="st-checkbox-box" aria-hidden="true"><span className="codicon codicon-check" /></span>
    </span>
  )
}

/** Switch untuk flag/enum on-off, dropdown untuk enum, input untuk number/string (placeholder dari default). */
export function EnvValueControl({ entry, value, disabled, onChange, id, describedBy, invalid }: Props): React.JSX.Element {
  const name = id ? undefined : envAriaName(entry)
  if (isSwitch(entry)) {
    return <Switch on={flagIsOn(value)} id={id} name={envAriaName(entry)} disabled={disabled} describedBy={describedBy}
      onChange={(on) => onChange(on ? ENV.on : ENV.off)} />
  }
  if (entry.kind === 'enum') {
    const options = entry.options ?? []
    const match = options.find((o) => norm(o) === norm(value))
    const bad = match === undefined && value.trim() !== ''
    const shown = value.length > INVALID_MAX ? `${value.slice(0, INVALID_MAX)}…` : value
    const labelOf = (o: string): string => entry.optionLabels?.[o] ?? o
    // Select native sendiri (bukan SettingsSelect) karena butuh aria-invalid + opsi tidak sah.
    return (
      <>
        <span className="st-select-wrap">
          <select id={id} className="st-select" aria-label={name} aria-invalid={bad || invalid || undefined}
            aria-describedby={describedBy} value={bad ? INVALID_VALUE : (match ?? value)} disabled={disabled}
            onChange={(e) => onChange(e.target.value)}>
            {bad && <option value={INVALID_VALUE}>{`— ${ENV.invalidOption}: "${shown}" —`}</option>}
            {options.map((o) => <option key={o} value={o}>{labelOf(o)}</option>)}
          </select>
          <span className="codicon codicon-chevron-down st-select-chevron" aria-hidden="true" />
        </span>
        {bad && <span className="st-note" role="note">{ENV.invalidEnumNote}</span>}
      </>
    )
  }
  const range = entry.kind === 'number' ? rangeText(entry) : ''
  return (
    <>
      <Input id={id} className="st-input st-mono" type="text" inputMode={entry.kind === 'number' ? 'decimal' : undefined}
        aria-label={name} aria-invalid={invalid || undefined} aria-describedby={describedBy}
        placeholder={entry.unsetLabel ?? entry.default ?? ''} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} />
      {range ? <span className="st-note">{range}</span> : null}
    </>
  )
}
