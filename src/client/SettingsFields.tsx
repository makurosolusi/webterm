// Typed Settings fields: each pairs one `Settings` key with a control of the matching type inside the
// shared row (`Field`, ./SettingsFieldRow). Booleans are the shadcn Switch on the right of the row, as in
// macOS System Settings, Linear and GitHub; one-of-few choices are the segmented control.
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { Lock } from '@/components/ui/disabled-reason'
import type { Settings } from '../shared/settings'
import { Field, lockReasonId } from './SettingsFieldRow'
import { useLocalFieldSave } from './settingsSave'
import { SettingsSegmented, SettingsSelect, type SegmentedOption } from './SettingsControls'

export {
  Field, FIELD_TEXT, FieldSaveStatus, highlightMatches, lockReasonId, matchesSearch, normalizeQuery, resetConfirmTitle,
  SafeguardNote, SettingsSearchProvider, useSettingsSearch, type FieldProps,
} from './SettingsFieldRow'

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
  hint?: string
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

/** Select for a union-typed key. `options` must come from that union, so the compiler rejects an
 *  option the schema no longer has. */
export function SelectField<T extends string>({
  id,
  label,
  hint,
  setting,
  value,
  options,
  onChange,
  disabled,
  lock,
}: {
  id: string
  label: string
  hint?: string
  setting?: keyof Settings
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  lock?: Lock
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting} lock={lock}>
      <SettingsSelect id={id} value={value} options={options} onChange={onChange} disabled={disabled || lock !== undefined} describedBy={lock ? lockReasonId(id) : undefined} />
    </Field>
  )
}

/** On/off setting: the shadcn Switch, right-aligned in the row. `savedLocally`: stored in this browser
 *  (no request), so each change shows "Saved on this browser" for a moment. */
export function ToggleField({
  id,
  label,
  hint,
  setting,
  value,
  onChange,
  lock,
  tone,
  savedLocally,
  modified,
  onReset,
}: {
  id: string
  label: string
  hint?: string
  setting?: keyof Settings
  value: boolean
  onChange: (v: boolean) => void
  lock?: Lock
  tone?: 'warning'
  savedLocally?: boolean
  /** Differs from its default, when not a `setting` (Field `modified`). */
  modified?: boolean
  onReset?: () => void
}): React.JSX.Element | null {
  const [localSave, markSaved] = useLocalFieldSave()
  return (
    <Field label={label} hint={hint} htmlFor={id} setting={setting} lock={lock} tone={tone}
      save={savedLocally ? localSave : undefined} modified={modified} onReset={onReset}>
      <Switch id={id} checked={value} disabled={lock !== undefined} aria-describedby={lock ? lockReasonId(id) : undefined}
        onCheckedChange={(v) => { onChange(v); if (savedLocally) markSaved() }} />
    </Field>
  )
}

/** One-of-few choice (2-4 options) as a segmented control; more options belong in `SelectField`. */
export function SegmentedField<T extends string>({ id, label, hint, setting, value, options, onChange, lock }: {
  id: string
  label: string
  hint?: string
  setting?: keyof Settings
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (v: T) => void
  lock?: Lock
}): React.JSX.Element | null {
  return (
    <Field label={label} hint={hint} setting={setting} lock={lock} htmlFor={id}>
      <SettingsSegmented id={id} ariaLabel={label} value={value} options={options} onChange={onChange}
        disabled={lock !== undefined} describedBy={lock ? lockReasonId(id) : undefined} />
    </Field>
  )
}

/** Color: native `<input type="color">` paired with a hex field, so the value can be read, copied and
 *  pasted (the picker alone cannot show the chosen hex). */
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
  hint?: string
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
