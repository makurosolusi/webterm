// Primitif kontrol untuk SettingsPanel. Tiap field memasangkan satu kunci `Settings` dengan satu
// kontrol yang tipenya cocok; label + deskripsi diambil dari doc-comment kunci di
// `shared/settings.ts` (di situ alasan defaultnya tertulis, dan user layak tahu).
//
// Bentuk item mengikuti VS Code Settings editor: judul `Kategori: Nama`, deskripsi redup, lalu
// kontrol di bawahnya; boolean memakai checkbox native (bukan switch) dengan deskripsi di
// sampingnya. Kontrol tetap native/shadcn yang di-restyle lewat `settings-controls.css`.
//
// Pencarian: `SettingsSearchProvider` membawa query yang sudah dinormalisasi, dan `Field`
// menyembunyikan dirinya sendiri ketika label + hint tidak cocok. Itu membuat filter bekerja
// untuk semua section sekaligus tanpa daftar indeks terpisah yang bisa basi.
import { createContext, useContext, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Settings } from '../shared/settings'
import { isModified, resetPatch, useSettingsItemScope } from './settingsContext'
import { SettingsCheckbox, SettingsSelect } from './SettingsControls'

const SearchContext = createContext('')

/** Normalisasi query: trim + lowercase. Token dipisah spasi dan harus cocok SEMUA. */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function matchesSearch(text: string, query: string): boolean {
  if (!query) return true
  const haystack = text.toLowerCase()
  return query.split(' ').every((token) => haystack.includes(token))
}

function hintText(hint: ReactNode): string {
  if (typeof hint === 'string' || typeof hint === 'number') return String(hint)
  return ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Sorot tiap token query di label — VS Code juga menandai teks yang cocok. */
function highlightMatches(text: string, query: string): ReactNode {
  if (!query) return text
  const tokens = query.split(' ').filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0) return text
  const re = new RegExp(`(${tokens.join('|')})`, 'ig')
  const parts = text.split(re)
  return parts.map((part, index) => {
    const hit = tokens.some((token) => new RegExp(`^${token}$`, 'i').test(part))
    return hit ? <mark key={index} className="st-mark">{part}</mark> : part
  })
}

export function useSettingsSearch(): string {
  return useContext(SearchContext)
}

export function SettingsSearchProvider({
  query,
  children,
}: {
  query: string
  children: ReactNode
}): React.JSX.Element {
  return <SearchContext.Provider value={query}>{children}</SearchContext.Provider>
}

export function Field({
  label,
  hint,
  htmlFor,
  block,
  inline,
  setting,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  /** Grup selebar baris (daftar launch command, kartu agent): kontrol memenuhi lebar item. */
  block?: boolean
  /** Boolean: kontrol (checkbox) sejajar dengan deskripsi, bukan di bawahnya. */
  inline?: boolean
  /** Kunci Settings yang diwakili; mengaktifkan penanda "Modified" dan Reset Setting. */
  setting?: keyof Settings
  children: ReactNode
}): React.JSX.Element | null {
  const query = useSettingsSearch()
  const { category, settings, onChange } = useSettingsItemScope()
  if (!matchesSearch(`${label} ${hintText(hint)}`, query)) return null

  const modified = setting !== undefined && settings !== undefined && isModified(settings, setting)
  const description = hint ? <p className="st-hint">{hint}</p> : null
  return (
    <div
      className={'st-field' + (block ? ' st-field--block' : '') + (modified ? ' is-modified' : '')}
      data-slot="settings-field"
    >
      <div className="st-title">
        {category ? <span className="st-category">{category}: </span> : null}
        <Label className="st-label" htmlFor={htmlFor}>{highlightMatches(label, query)}</Label>
        {modified ? <span className="st-modified">(Modified)</span> : null}
        {modified && setting && onChange ? (
          <button
            type="button"
            className="st-gear"
            title="Reset Setting"
            aria-label={`Reset Setting: ${label}`}
            onClick={() => onChange(resetPatch(setting))}
          >
            <span className="codicon codicon-gear" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {inline ? (
        <div className="st-checkline">
          <div className="st-control">{children}</div>
          {description}
        </div>
      ) : (
        <>
          {description}
          <div className="st-control">{children}</div>
        </>
      )}
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
  setting,
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
  setting?: keyof Settings
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
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
  setting,
  value,
  placeholder,
  mono,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  setting?: keyof Settings
  value: string
  placeholder?: string
  mono?: boolean
  onChange: (v: string) => void
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
      <Input
        id={id}
        className={mono ? 'st-input st-mono' : 'st-input'}
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
  setting,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  setting?: keyof Settings
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
      <SettingsSelect id={id} value={value} options={options} onChange={onChange} />
    </Field>
  )
}

export function ToggleField({
  id,
  label,
  hint,
  setting,
  value,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  setting?: keyof Settings
  value: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting} inline>
      <SettingsCheckbox id={id} checked={value} onChange={onChange} />
    </Field>
  )
}

/** Warna: `<input type="color">` native, berpasangan dengan field hex supaya nilainya bisa
 *  dibaca, disalin, dan ditempel — picker saja tidak bisa menampilkan hex yang terpilih. */
export function ColorField({
  id,
  label,
  hint,
  setting,
  value,
  onChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  setting?: keyof Settings
  value: string
  onChange: (v: string) => void
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting}>
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
