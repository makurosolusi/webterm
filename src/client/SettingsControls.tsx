// Dua kontrol bentuk VS Code yang dipakai semua section Settings: dropdown (`<select>` native,
// persis yang dipakai Settings editor VS Code) dan checkbox 18x18. Native dipertahankan supaya
// label association, keyboard, dan popup OS tidak perlu ditiru ulang.

interface SelectProps<T extends string> {
  id?: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
}

/** Satu-satunya gaya dropdown di Settings: 26px, token dropdown, chevron codicon, teks panjang di-ellipsis. */
export function SettingsSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: SelectProps<T>): React.JSX.Element {
  return (
    <span className="st-select-wrap">
      <select
        id={id}
        className="st-select"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
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
}: {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <span className="st-checkbox">
      <input
        id={id}
        type="checkbox"
        aria-label={ariaLabel}
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
