// The forms of SignInScreen (and the /m sign-in): username + password sign-in and the "open a
// window on this computer" button; first-run setup lives in signIn/SetupForm.tsx. Each owns its
// pending/error/429 state and calls `onDone` once the server set the session cookie. Sentences: signInLabels.ts.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { loginWithPassword } from './account.api.client'
import { AuthField } from './signIn/AuthField'
import { causeOf, FormAlert, SubmitButton } from './signIn/authFormParts'
import { useFieldChecks } from './signIn/useFieldChecks'
import { authErrorText, SIGN_IN_TEXT } from './signInLabels'
import { requestOpen } from './transportToken'
import { useAuthSubmit } from './useAuthSubmit'
import { useCountdown } from './useCountdown'

const HTTP_ACCEPTED = 202
const HTTP_TOO_MANY = 429
const MUTED = 'text-center text-xs text-[var(--vscode-descriptionForeground)] text-balance'

export interface OpenWindowButtonProps {
  label: string
  variant?: 'default' | 'outline'
  now: () => number
}

/** POST /auth/request-open with `next` = where the user is now; shows opening / countdown / error + Retry. */
export function OpenWindowButton({ label, variant = 'default', now }: OpenWindowButtonProps): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'opening' | { until: number } | { error: string }>('idle')
  const [pending, setPending] = useState(false)
  const until = typeof state === 'object' && 'until' in state ? state.until : 0
  const left = useCountdown(until, now)
  const open = (): void => {
    setPending(true)
    requestOpen().then(
      ({ status, retryAfterS }) => {
        if (status === HTTP_ACCEPTED) setState('opening')
        else if (status === HTTP_TOO_MANY) setState({ until: now() + retryAfterS * 1000 })
        else setState({ error: SIGN_IN_TEXT.failed('Opening a signed-in window', `HTTP ${status}`) })
      },
      (e: unknown) => setState({ error: SIGN_IN_TEXT.failed('Opening a signed-in window', causeOf(e)) }),
    ).finally(() => setPending(false))
  }
  return (
    <div className="flex w-full flex-col items-stretch gap-2">
      <Button type="button" className="h-8 w-full" variant={variant} disabled={pending || left > 0} onClick={open}>
        {pending ? <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> : null}{label}
      </Button>
      {state === 'opening' ? <p role="status" className={MUTED}>{SIGN_IN_TEXT.opening}</p> : null}
      {left > 0 ? <p role="status" className={MUTED}>{SIGN_IN_TEXT.rateLimited(left)}</p> : null}
      {typeof state === 'object' && 'error' in state ? (
        <div className="flex flex-col items-stretch gap-2">
          <FormAlert text={state.error} />
          <Button type="button" variant="outline" className="h-8" onClick={open}>{SIGN_IN_TEXT.retry}</Button>
        </div>
      ) : null}
    </div>
  )
}

export interface LoginFormProps {
  /** The server answered 200 and set the cookie. */
  onDone: () => void
  now?: () => number
  idPrefix?: string
}

const ORDER = ['username', 'password'] as const

/** Username + password sign-in: inline "required" errors, 401 wrong credentials, 429 countdown from Retry-After. */
export function LoginForm({ onDone, now = Date.now, idPrefix = 'signin' }: LoginFormProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const s = useAuthSubmit(now, authErrorText)
  const f = useFieldChecks({
    username: username.trim() === '' ? SIGN_IN_TEXT.needUsername : null,
    password: password === '' ? SIGN_IN_TEXT.needPassword : null,
  }, ORDER)
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked) return
    s.setFailure(null)
    if (!f.validate()) return
    s.setPending(true)
    loginWithPassword(username.trim(), password).then(
      (r) => (r.ok ? onDone() : s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })),
      (err: unknown) => s.setFailure({ message: SIGN_IN_TEXT.failed('Signing in', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} noValidate className="flex w-full flex-col gap-4" aria-label={SIGN_IN_TEXT.title}>
      <AuthField
        id={`${idPrefix}-username`} label={SIGN_IN_TEXT.usernameLabel} autoComplete="username" value={username} onChange={setUsername}
        readOnly={s.pending} autoFocus error={f.shown('username')} onBlur={f.blur('username', username)} inputRef={f.ref('username')}
      />
      <AuthField
        id={`${idPrefix}-password`} label={SIGN_IN_TEXT.passwordLabel} autoComplete="current-password" value={password} onChange={setPassword}
        readOnly={s.pending} error={f.shown('password')} onBlur={f.blur('password', password)} inputRef={f.ref('password')}
      />
      <FormAlert text={s.text} />
      <SubmitButton label={SIGN_IN_TEXT.signIn} pendingLabel={SIGN_IN_TEXT.signingIn} pending={s.pending} blocked={s.blocked} />
    </form>
  )
}
