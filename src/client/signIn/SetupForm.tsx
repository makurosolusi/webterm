// First-run owner account: username, password with a live requirement checklist, and confirmation.
// One show/hide toggle drives both password fields. Inline errors on blur and submit (the first
// invalid field takes focus); the server answer goes to the alert above the button.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { setupAccount } from '../account.api.client'
import { authErrorText, charCount, PASSWORD_MIN, SIGN_IN_TEXT, USERNAME_PATTERN } from '../signInLabels'
import { useAuthSubmit } from '../useAuthSubmit'
import { AuthField } from './AuthField'
import { FormAlert, PasswordChecklist, SubmitButton, useAlertGrab } from './authFormParts'
import { useFieldChecks } from './useFieldChecks'

export interface SetupFormProps {
  onDone: () => void
  /** 409 already_setup: someone else created the account; the "Sign in" button next to the alert calls this. */
  onAlreadySetup: () => void
  now?: () => number
}

const ORDER = ['username', 'password', 'confirm'] as const
const PREFIX = 'setup'
const HTTP_TOO_MANY = 429
const HTTP_SERVER_ERROR = 500

/** The create-account form; sends exactly what the server contract (POST /auth/setup) takes. */
export function SetupForm({ onDone, onAlreadySetup, now = Date.now }: SetupFormProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [shown, setShown] = useState(false)
  const [exists, setExists] = useState(false)
  const s = useAuthSubmit(now, authErrorText)
  const [grab, grabAlert] = useAlertGrab()
  const name = username.trim()
  const longEnough = charCount(password) >= PASSWORD_MIN
  const matches = confirm !== '' && confirm === password
  const errors = {
    username: name === '' ? SIGN_IN_TEXT.needUsername : USERNAME_PATTERN.test(name) ? null : SIGN_IN_TEXT.invalidUsername,
    password: longEnough ? null : SIGN_IN_TEXT.weakPassword,
    confirm: confirm === '' ? SIGN_IN_TEXT.needConfirm : matches ? null : SIGN_IN_TEXT.mismatch,
  }
  const valid = errors.username === null && errors.password === null && errors.confirm === null
  const f = useFieldChecks(errors, ORDER)
  const focus = (id: string): void => { document.getElementById(`${PREFIX}-${id}`)?.focus() }
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked || !valid) return
    s.setFailure(null)
    setExists(false)
    if (!f.validate()) return
    s.setPending(true)
    setupAccount(name, password).then(
      (r) => {
        if (r.ok) return onDone()
        if (r.error === 'already_setup') setExists(true)
        s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
        // Back to the field the answer is about (focus is not lost by readOnly, so no wait is needed).
        if (r.error === 'invalid_username') focus('username')
        else if (r.error === 'weak_password') focus('password')
        else if (r.status === HTTP_TOO_MANY || r.status >= HTTP_SERVER_ERROR) grabAlert()
      },
      () => { s.setFailure({ message: SIGN_IN_TEXT.unreachable }); grabAlert() },
    ).finally(() => s.setPending(false))
  }
  const checklistId = `${PREFIX}-requirements`
  return (
    <form onSubmit={submit} noValidate className="flex w-full min-w-0 max-w-full flex-col gap-4" aria-label={SIGN_IN_TEXT.setupTitle}>
      <AuthField
        id={`${PREFIX}-username`} label={SIGN_IN_TEXT.usernameLabel} autoComplete="username" value={username} onChange={setUsername} readOnly={s.pending}
        autoFocus hint={SIGN_IN_TEXT.usernameHint} error={f.shown('username')} onBlur={f.blur('username', username)} inputRef={f.ref('username')}
      />
      <AuthField
        id={`${PREFIX}-password`} label={SIGN_IN_TEXT.passwordLabel} autoComplete="new-password" value={password} onChange={setPassword} readOnly={s.pending}
        describedBy={checklistId} error={f.shown('password')} onBlur={f.blur('password', password)} inputRef={f.ref('password')}
        shown={shown} onToggleShown={() => setShown((v) => !v)}
      />
      <AuthField
        id={`${PREFIX}-confirm`} label={SIGN_IN_TEXT.confirmLabel} autoComplete="new-password" value={confirm} onChange={setConfirm} readOnly={s.pending}
        describedBy={checklistId} error={f.shown('confirm')} onBlur={f.blur('confirm', confirm)} inputRef={f.ref('confirm')} shown={shown}
        status={matches ? <span className="sign-in-check codicon codicon-check px-0.5" data-met="true" role="img" aria-label={SIGN_IN_TEXT.matches} /> : null}
      />
      <PasswordChecklist id={checklistId} items={[{ label: SIGN_IN_TEXT.checkLength, met: longEnough }, { label: SIGN_IN_TEXT.checkMatch, met: matches }]} />
      <FormAlert text={s.text} grab={grab} />
      {exists ? <Button type="button" variant="link" className="h-auto self-start p-0" autoFocus onClick={onAlreadySetup}>{SIGN_IN_TEXT.signIn}</Button> : null}
      <SubmitButton label={SIGN_IN_TEXT.create} pendingLabel={SIGN_IN_TEXT.creating} pending={s.pending} blocked={s.blocked} disabled={!valid} />
    </form>
  )
}
