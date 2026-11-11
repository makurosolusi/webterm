// The forms of SignInScreen (and the /m sign-in): username + password sign-in, first-run account
// setup, and the "open a window on this computer" button. Each owns its pending/error/429 state and
// calls `onDone` once the server set the session cookie. Sentences: signInLabels.ts.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { loginWithPassword, setupAccount } from './account.api.client'
import { PasswordField } from './PasswordField'
import { authErrorText, charCount, PASSWORD_MIN, SIGN_IN_TEXT } from './signInLabels'
import { requestOpen } from './transportToken'
import { useAuthSubmit } from './useAuthSubmit'
import { useCountdown } from './useCountdown'

const HTTP_ACCEPTED = 202
const HTTP_TOO_MANY = 429
const MUTED = 'max-w-[440px] text-center text-xs text-[var(--vscode-descriptionForeground)]'
const ALERT = 'max-w-[440px] text-center text-xs text-[var(--vscode-errorForeground)]'

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
    <div className="flex flex-col items-center gap-2">
      <Button type="button" variant={variant} disabled={pending || left > 0} onClick={open}>{label}</Button>
      {state === 'opening' ? <p role="status" className={MUTED}>{SIGN_IN_TEXT.opening}</p> : null}
      {left > 0 ? <p role="status" className={MUTED}>{SIGN_IN_TEXT.rateLimited(left)}</p> : null}
      {typeof state === 'object' && 'error' in state ? (
        <div role="alert" className="flex flex-col items-center gap-2">
          <p className={ALERT}>{state.error}</p>
          <Button type="button" variant="outline" onClick={open}>{SIGN_IN_TEXT.retry}</Button>
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

/** Username + password sign-in: 401 wrong credentials, 429 countdown from Retry-After. */
export function LoginForm({ onDone, now = Date.now, idPrefix = 'signin' }: LoginFormProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const s = useAuthSubmit(now, authErrorText)
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked || username.trim() === '' || password === '') return
    s.setPending(true)
    s.setFailure(null)
    loginWithPassword(username.trim(), password).then(
      (r) => (r.ok ? onDone() : s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })),
      (err: unknown) => s.setFailure({ message: SIGN_IN_TEXT.failed('Signing in', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} className="flex w-[300px] max-w-full flex-col items-stretch gap-3" aria-label={SIGN_IN_TEXT.title}>
      <PasswordField id={`${idPrefix}-username`} label={SIGN_IN_TEXT.usernameLabel} autoComplete="username" value={username} onChange={setUsername} disabled={s.pending} />
      <PasswordField id={`${idPrefix}-password`} label={SIGN_IN_TEXT.passwordLabel} autoComplete="current-password" value={password} onChange={setPassword} disabled={s.pending} />
      <Button type="submit" disabled={s.pending || s.blocked || username.trim() === '' || password === ''}>{s.pending ? SIGN_IN_TEXT.working : SIGN_IN_TEXT.signIn}</Button>
      {s.text ? <p role="alert" className={ALERT}>{s.text}</p> : null}
    </form>
  )
}

export interface SetupFormProps {
  /** No proof yet: ask for the setup code from `<data dir>/secrets/SETUP_CODE`. */
  withCode: boolean
  onDone: () => void
  /** 409 already_setup: someone else created the account; the caller switches to sign-in. */
  onAlreadySetup: () => void
  now?: () => number
}

/** First-run owner account: username, password (live length hint), confirm, optional setup code. */
export function SetupForm({ withCode, onDone, onAlreadySetup, now = Date.now }: SetupFormProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const s = useAuthSubmit(now, authErrorText)
  const prefix = withCode ? 'setup-remote' : 'setup'
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || username.trim() === '') return
    if (charCount(password) < PASSWORD_MIN) return s.setFailure({ message: SIGN_IN_TEXT.weakPassword })
    if (password !== confirm) return s.setFailure({ message: SIGN_IN_TEXT.mismatch })
    s.setPending(true)
    s.setFailure(null)
    setupAccount(username.trim(), password, withCode ? code.trim() : undefined).then(
      (r) => {
        if (r.ok) return onDone()
        if (r.error === 'already_setup') return onAlreadySetup()
        s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
      },
      (err: unknown) => s.setFailure({ message: SIGN_IN_TEXT.failed('Creating the account', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} className="flex w-[300px] max-w-full flex-col items-stretch gap-3" aria-label={SIGN_IN_TEXT.setupTitle}>
      {withCode ? (
        <PasswordField id={`${prefix}-code`} label={SIGN_IN_TEXT.setupCodeLabel} autoComplete="off" value={code} onChange={setCode} disabled={s.pending} hint={SIGN_IN_TEXT.setupCodeHint} />
      ) : null}
      <PasswordField id={`${prefix}-username`} label={SIGN_IN_TEXT.usernameLabel} autoComplete="username" value={username} onChange={setUsername} disabled={s.pending} />
      <PasswordField
        id={`${prefix}-password`} label={SIGN_IN_TEXT.passwordLabel} autoComplete="new-password" value={password} onChange={setPassword}
        disabled={s.pending} hint={SIGN_IN_TEXT.lengthHint(charCount(password))}
      />
      <PasswordField id={`${prefix}-confirm`} label={SIGN_IN_TEXT.confirmLabel} autoComplete="new-password" value={confirm} onChange={setConfirm} disabled={s.pending} />
      <Button type="submit" disabled={s.pending || username.trim() === '' || (withCode && code.trim() === '')}>{s.pending ? SIGN_IN_TEXT.working : SIGN_IN_TEXT.create}</Button>
      {s.text ? <p role="alert" className={ALERT}>{s.text}</p> : null}
    </form>
  )
}
