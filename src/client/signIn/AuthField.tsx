// One labelled field of the sign-in and setup forms: a 44px input (16px text, no iOS zoom), the show/hide
// toggle as a 44px icon button inside password inputs, a Caps Lock hint, an optional hint, and the inline
// error wired through aria-invalid and aria-describedby. The Account and mobile forms keep the older PasswordField.
import { useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SIGN_IN_TEXT } from '../signInLabels'
import '../sign-in.css'

export interface AuthFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  /** `username` / `off` are plain text; the password kinds get the show/hide toggle. */
  autoComplete: 'username' | 'current-password' | 'new-password' | 'off'
  /** Read-only while a submit is in flight: the value is frozen but focus stays put. */
  readOnly?: boolean
  autoFocus?: boolean
  hint?: string
  /** Shown only once the form decided to show it (blur or submit). */
  error?: string | null
  /** Extra ids the input is described by, e.g. the password checklist. */
  describedBy?: string
  /** Glyph shown inside the input before the toggle, e.g. the match check on Confirm. */
  status?: React.ReactNode
  /** Controlled visibility, so one toggle can drive two password fields; omit `onToggleShown` on the follower. */
  shown?: boolean
  onToggleShown?: () => void
  onBlur?: () => void
  inputRef?: (el: HTMLInputElement | null) => void
}

/** Label + input + hint + inline error. */
export function AuthField({ id, label, value, onChange, autoComplete, readOnly, autoFocus, hint, error, describedBy, status, shown: shownProp, onToggleShown, onBlur, inputRef }: AuthFieldProps): React.JSX.Element {
  const [localShown, setLocalShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const shown = shownProp ?? localShown
  const secret = autoComplete === 'current-password' || autoComplete === 'new-password'
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const capsId = caps ? `${id}-caps` : undefined
  const toggles = secret && (shownProp === undefined || onToggleShown !== undefined)
  const described = [hintId, capsId, errorId, describedBy].filter(Boolean).join(' ') || undefined
  const name = label.toLowerCase()
  return (
    <div className="flex w-full flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id} ref={inputRef} value={value} readOnly={readOnly} autoFocus={autoFocus} autoComplete={autoComplete}
          aria-describedby={described} aria-invalid={error ? true : undefined}
          type={secret && !shown ? 'password' : 'text'} spellCheck={false} autoCapitalize="off" autoCorrect="off" name={id}
          className={`sign-in-field__input h-11 px-3 text-base md:text-base ${secret ? (status ? 'pr-24' : 'pr-12') : ''}`.trimEnd()}
          onChange={(e) => onChange(e.target.value)} onBlur={() => { setCaps(false); onBlur?.() }}
          onKeyUp={secret ? (e) => setCaps(e.getModifierState('CapsLock')) : undefined}
        />
        {secret ? (
          <div className="absolute inset-y-0 right-0 flex items-center">
            {status}
            {toggles ? (
              <IconButton
                type="button" size="icon-sm" aria-pressed={shown} className="size-11"
                label={shown ? SIGN_IN_TEXT.hide(name) : SIGN_IN_TEXT.show(name)}
                onClick={onToggleShown ?? (() => setLocalShown((v) => !v))}
              >
                <span className={`codicon codicon-${shown ? 'eye-closed' : 'eye'}`} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {hint ? <p id={hintId} className="text-[13px] leading-4 text-[var(--vscode-descriptionForeground)]">{hint}</p> : null}
      {caps ? <p id={capsId} className="flex items-center gap-1 text-[13px] leading-4 text-[var(--vscode-descriptionForeground)]"><span className="codicon codicon-warning shrink-0" aria-hidden="true" />{SIGN_IN_TEXT.capsLock}</p> : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1 text-[13px] leading-4 text-[var(--vscode-errorForeground)]">
          <span className="codicon codicon-error mt-px shrink-0" aria-hidden="true" />{error}
        </p>
      ) : null}
    </div>
  )
}
