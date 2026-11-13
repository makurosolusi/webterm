// First-run owner account: optional setup code, username, password with a live requirement
// checklist, and confirmation with a match check. Inline errors on blur and submit (the first
// invalid field takes focus); the server answer goes to the alert above the button.
import { useState } from 'react'
import { setupAccount } from '../account.api.client'
import { authErrorText, charCount, PASSWORD_MIN, SIGN_IN_TEXT, USERNAME_PATTERN } from '../signInLabels'
import { useAuthSubmit } from '../useAuthSubmit'
import { AuthField } from './AuthField'
import { causeOf, FormAlert, PasswordChecklist, SubmitButton } from './authFormParts'
import { useFieldChecks } from './useFieldChecks'

export interface SetupFormProps {
  /** No proof yet: ask for the setup code from `<data dir>/secrets/SETUP_CODE`. */
  withCode: boolean
  onDone: () => void
  /** 409 already_setup: someone else created the account; the caller switches to sign-in. */
  onAlreadySetup: () => void
  now?: () => number
  /** Focus the first field on mount (off when the form sits in a closed disclosure). */
  autoFocus?: boolean
}

const ORDER = ['code', 'username', 'password', 'confirm'] as const

/** The create-account form; sends exactly what the server contract (POST /auth/setup) takes. */
export function SetupForm({ withCode, onDone, onAlreadySetup, now = Date.now, autoFocus = false }: SetupFormProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const s = useAuthSubmit(now, authErrorText)
  const prefix = withCode ? 'setup-remote' : 'setup'
  const name = username.trim()
  const longEnough = charCount(password) >= PASSWORD_MIN
  const matches = confirm !== '' && confirm === password
  const errors = {
    code: withCode && code.trim() === '' ? SIGN_IN_TEXT.needCode : null,
    username: name === '' ? SIGN_IN_TEXT.needUsername : USERNAME_PATTERN.test(name) ? null : SIGN_IN_TEXT.invalidUsername,
    password: longEnough ? null : SIGN_IN_TEXT.weakPassword,
    confirm: confirm === '' ? SIGN_IN_TEXT.needConfirm : matches ? null : SIGN_IN_TEXT.mismatch,
  }
  const f = useFieldChecks(errors, ORDER)
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked) return
    s.setFailure(null)
    if (!f.validate()) return
    s.setPending(true)
    setupAccount(name, password, withCode ? code.trim() : undefined).then(
      (r) => {
        if (r.ok) return onDone()
        if (r.error === 'already_setup') return onAlreadySetup()
        s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
      },
      (err: unknown) => s.setFailure({ message: SIGN_IN_TEXT.failed('Creating the account', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  const checklistId = `${prefix}-requirements`
  return (
    <form onSubmit={submit} noValidate className="flex w-full flex-col gap-4" aria-label={SIGN_IN_TEXT.setupTitle}>
      {withCode ? (
        <AuthField
          id={`${prefix}-code`} label={SIGN_IN_TEXT.setupCodeLabel} autoComplete="off" value={code} onChange={setCode} readOnly={s.pending}
          autoFocus={autoFocus} hint={SIGN_IN_TEXT.setupCodeHint} error={f.shown('code')} onBlur={f.blur('code', code)} inputRef={f.ref('code')}
        />
      ) : null}
      <AuthField
        id={`${prefix}-username`} label={SIGN_IN_TEXT.usernameLabel} autoComplete="username" value={username} onChange={setUsername} readOnly={s.pending}
        autoFocus={autoFocus && !withCode} hint={SIGN_IN_TEXT.usernameHint} error={f.shown('username')} onBlur={f.blur('username', username)} inputRef={f.ref('username')}
      />
      <AuthField
        id={`${prefix}-password`} label={SIGN_IN_TEXT.passwordLabel} autoComplete="new-password" value={password} onChange={setPassword} readOnly={s.pending}
        describedBy={checklistId} error={f.shown('password')} onBlur={f.blur('password', password)} inputRef={f.ref('password')}
      />
      <AuthField
        id={`${prefix}-confirm`} label={SIGN_IN_TEXT.confirmLabel} autoComplete="new-password" value={confirm} onChange={setConfirm} readOnly={s.pending}
        describedBy={checklistId} error={f.shown('confirm')} onBlur={f.blur('confirm', confirm)} inputRef={f.ref('confirm')}
        status={matches ? <span className="sign-in-check codicon codicon-check px-0.5" data-met="true" role="img" aria-label={SIGN_IN_TEXT.matches} /> : null}
      />
      <PasswordChecklist id={checklistId} items={[{ label: SIGN_IN_TEXT.checkLength, met: longEnough }, { label: SIGN_IN_TEXT.checkMatch, met: matches }]} />
      <FormAlert text={s.text} />
      <SubmitButton label={SIGN_IN_TEXT.create} pendingLabel={SIGN_IN_TEXT.creating} pending={s.pending} blocked={s.blocked} />
    </form>
  )
}
