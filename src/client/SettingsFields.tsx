// Primitif kontrol untuk SettingsPanel. Tiap field memasangkan satu kunci `Settings` dengan satu
// kontrol yang tipenya cocok; label + deskripsi diambil dari doc-comment kunci di
// `shared/settings.ts` (di situ alasan defaultnya tertulis, dan user layak tahu).
import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="st-field">
      <div className="st-field-text">
        <Label className="st-label" htmlFor={htmlFor}>{label}</Label>
        {hint ? <p className="st-hint">{hint}</p> : null}
      </div>
      <div className="st-control">{children}</div>
    </div>
  )
}

/**
 * Number dengan clamp. Clamp terjadi saat COMMIT (blur/Enter), bukan per ketukan: mengoreksi
 * angka selagi diketik membuat "1" di jalan menuju "13" langsung melompat ke min.
 */
export function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        className="st-input st-input-num"
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        onBlur={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value)
        }}
      />
      {unit ? <span className="st-unit">{unit}</span> : null}
    </Field>
  )
}

export function TextField({
  id,
  label,
  hint,
  value,
  placeholder,
  mono,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  value: string
  placeholder?: string
  mono?: boolean
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        className={'st-input' + (mono ? ' st-mono' : '')}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

/** Select untuk kunci bertipe union. `options` harus datang dari tipe union itu sendiri supaya
 *  compiler menolak opsi yang sudah tidak ada di skema. */
export function SelectField<T extends string>({
  id,
  label,
  hint,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="st-input st-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function ToggleField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  value: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Switch
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        className={'st-toggle' + (value ? ' is-on' : '')}
        checked={value}
        onCheckedChange={onChange}
      />
    </Field>
  )
}

/** Warna: `<input type="color">` native, berpasangan dengan field hex supaya nilainya bisa
 *  dibaca, disalin, dan ditempel — picker saja tidak bisa menampilkan hex yang terpilih. */
export function ColorField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input id={id} className="st-color" type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <Input
        className="st-input st-input-hex st-mono"
        type="text"
        aria-label={`${label} hex`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}
