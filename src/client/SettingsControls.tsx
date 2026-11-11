// Dua kontrol bentuk VS Code yang dipakai semua section Settings: dropdown (`<select>` native,
// persis yang dipakai Settings editor VS Code) dan checkbox 18x18. Native dipertahankan supaya
// label association, keyboard, dan popup OS tidak perlu ditiru ulang.

const SELECT_TEXT = { notInList: (value: string): string => `${value} (not in list)` } as const

interface SelectProps<T extends string> {
  id?: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
  /** id of the line that says why it is disabled (Field `lock`). */
  describedBy?: string
}

/** Satu-satunya gaya dropdown di Settings: 26px, token dropdown, chevron codicon, teks panjang di-ellipsis. */
export function SettingsSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  describedBy,
}: SelectProps<T>): React.JSX.Element {
  // A stored value outside the list (old preset, deleted profile) would render a blank native select:
  // show it as a disabled first option so the control says what is really stored.
  const known = options.some((o) => o.value === value)
  return (
    <span className="st-select-wrap">
      <select
        id={id}
        className="st-select"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {known ? null : <option value={value} disabled>{SELECT_TEXT.notInList(value)}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="codicon codicon-chevron-down st-select-chevron" aria-hidden="true" />
    </span>
  )
}

/** Checkbox VS Code: input native transparan di atas kotak gambar dengan centang codicon. */
export function SettingsCheckbox({
  id,
  checked,
  onChange,
  disabled,
  ariaLabel,
  describedBy,
}: {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  /** id of the line that says why it is disabled (Field `lock`). */
  describedBy?: string
}): React.JSX.Element {
  return (
    <span className="st-checkbox">
      <input
        id={id}
        type="checkbox"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="st-checkbox-box" aria-hidden="true">
        <span className="codicon codicon-check" />
      </span>
    </span>
  )
}
