// Labelled text/password field shared by the sign-in, setup, Account and mobile forms. The Show/Hide
// toggle is a text button (not an icon) so it needs no tooltip provider and reads the same on /m.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  /** `username` for the account name; otherwise a password field with Show/Hide. */
  autoComplete: 'username' | 'current-password' | 'new-password' | 'off'
  disabled?: boolean
  /** Line under the field (e.g. the live length hint); announced politely. */
  hint?: string
  invalid?: boolean
}

/** One labelled input; password kinds get a Show/Hide toggle with `aria-pressed`. */
export function PasswordField({ id, label, value, onChange, autoComplete, disabled, hint, invalid }: PasswordFieldProps): React.JSX.Element {
  const [shown, setShown] = useState(false)
  const secret = autoComplete !== 'username' && autoComplete !== 'off'
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className="flex w-full flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1">
        <Input
          id={id} value={value} disabled={disabled} autoComplete={autoComplete} aria-describedby={hintId} aria-invalid={invalid || undefined}
          type={secret && !shown ? 'password' : 'text'} spellCheck={false} autoCapitalize="none"
          onChange={(e) => onChange(e.target.value)}
        />
        {secret ? (
          <Button type="button" variant="ghost" size="sm" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`} onClick={() => setShown((v) => !v)}>
            {shown ? 'Hide' : 'Show'}
          </Button>
        ) : null}
      </div>
      {hint ? <p id={hintId} aria-live="polite" className="text-xs text-[var(--vscode-descriptionForeground)]">{hint}</p> : null}
    </div>
  )
}
