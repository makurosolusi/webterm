import './vscode-controls.css'

/**
 * VS Code-style toggle switch: 36x20 track with a 16px thumb.
 *
 * Native `<button role="switch">` keeps the control focusable and readable to
 * assistive tech without shadow DOM. Space and Enter are handled explicitly so the
 * toggle fires once (the browser's synthetic click on those keys is prevented).
 */
export interface VscodeSwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Accessible name; VS Code toggles are icon/size only, so this is required. */
  label: string
  disabled?: boolean
  id?: string
  className?: string
}

export function VscodeSwitch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  className,
}: VscodeSwitchProps) {
  const toggle = () => {
    if (!disabled) onCheckedChange(!checked)
  }

  return (
    <button
      type="button"
      role="switch"
      id={id}
      data-slot="vscode-switch"
      data-state={checked ? 'checked' : 'unchecked'}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={['vscode-switch', className].filter(Boolean).join(' ')}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          toggle()
        }
      }}
    >
      <span className="vscode-switch__thumb" data-slot="vscode-switch-thumb" aria-hidden="true" />
    </button>
  )
}
