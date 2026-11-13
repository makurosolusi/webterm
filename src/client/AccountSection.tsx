// Settings › Account (`?settings=account`), GitHub/Linear layout: a Username card (who is signed in, "Change
// username" opens the form, which needs the password), a Password card ("Change password" opens the form; it signs
// every other device out, OWASP ASVS 3.3) and Signed-in devices, whose row for this device is the one Sign out
// (without an account, a lone Sign out card stands in for it).
// Server: src/server/routes/auth.account.routes.ts. Sentences: accountLabels.ts.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { changePassword, changeUsername, replyUser } from './account.api.client'
import { ACCOUNT_TEXT, accountErrorText } from './accountLabels'
import { AccountSessions } from './AccountSessions'
import { PasswordField } from './PasswordField'
import { charCount, PASSWORD_MIN, SIGN_IN_TEXT } from './signInLabels'
import { fetchMe, type AuthUser } from './transportToken'
import { useAuthSubmit } from './useAuthSubmit'
import { useSignOut } from './useSignOut'

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface AccountSectionProps {
  /** After Sign out; tests replace it. Default reloads to the sign-in page. */
  reload?: () => void
  now?: () => number
}

/** The Account settings page. */
export function AccountSection({ reload, now = Date.now }: AccountSectionProps): React.JSX.Element {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionsKey, setSessionsKey] = useState(0)
  const { signOut, busy: signingOut, error: signOutError } = useSignOut(reload)

  const load = useCallback(() => {
    setLoadError(null)
    fetchMe().then((m) => setUser(m.user), (e: unknown) => setLoadError(ACCOUNT_TEXT.loadFailed(causeOf(e))))
  }, [])
  useEffect(load, [load])

  if (loadError || user === undefined) {
    return (
      <SettingsGroup title={ACCOUNT_TEXT.usernameGroup}>
        {loadError ? <CardError text={loadError} onRetry={load} /> : <CardLoading text={ACCOUNT_TEXT.loading} />}
      </SettingsGroup>
    )
  }
  return (
    <div className="flex flex-col" data-testid="account-section">
      {user ? (
        <>
          <UsernameCard user={user} onRenamed={setUser} now={now} />
          <PasswordCard onChanged={() => setSessionsKey((k) => k + 1)} now={now} />
          {/* The one Sign out with an account: this device's row in the devices list. */}
          <AccountSessions refreshKey={sessionsKey} onSignOutHere={signOut} signingOut={signingOut} now={now} />
        </>
      ) : (
        <SettingsGroup title={ACCOUNT_TEXT.signOutTitle} description={ACCOUNT_TEXT.noAccount}>
          <div className="st-field">
            <div className="st-field-text"><p className="st-row-meta">{ACCOUNT_TEXT.signOutIntro}</p></div>
            <div className="st-control">
              <Button size="sm" variant="outline" onClick={signOut} disabled={signingOut}>{signingOut ? ACCOUNT_TEXT.working : ACCOUNT_TEXT.signOut}</Button>
            </div>
          </div>
        </SettingsGroup>
      )}
      {signOutError ? <p role="alert" className="st-state st-state--error">{signOutError}</p> : null}
    </div>
  )
}

/** A card whose one row names the current state, with the button that opens its form below it. */
function FormCard({ title, line, open, onOpen, openLabel, saved, children }: {
  title: string; line: React.ReactNode; open: boolean; onOpen(): void; openLabel: string; saved: string | null; children: React.ReactNode
}): React.JSX.Element {
  return (
    <SettingsGroup title={title}>
      <div className="st-field">
        <div className="st-field-text">
          <div className="st-row-title">{line}</div>
          {saved ? <p role="status" className="st-row-meta">{saved}</p> : null}
        </div>
        {open ? null : <div className="st-control"><Button size="sm" variant="outline" onClick={onOpen}>{openLabel}</Button></div>}
      </div>
      {open ? children : null}
    </SettingsGroup>
  )
}

function UsernameCard({ user, onRenamed, now }: { user: AuthUser; onRenamed: (u: AuthUser) => void; now: () => number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  return (
    <FormCard title={ACCOUNT_TEXT.usernameGroup} open={open} onOpen={() => { setSaved(null); setOpen(true) }} openLabel={ACCOUNT_TEXT.usernameTitle} saved={saved}
      line={<>{ACCOUNT_TEXT.signedInAs} <strong data-testid="account-username">{user.username}</strong></>}>
      <UsernameForm onCancel={() => setOpen(false)} onRenamed={(u) => { onRenamed(u); setOpen(false); setSaved(ACCOUNT_TEXT.usernameChanged) }} now={now} />
    </FormCard>
  )
}

function PasswordCard({ onChanged, now }: { onChanged: () => void; now: () => number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  return (
    <FormCard title={ACCOUNT_TEXT.passwordGroup} open={open} onOpen={() => { setSaved(null); setOpen(true) }} openLabel={ACCOUNT_TEXT.passwordTitle} saved={saved}
      line={<span className="st-row-meta">{ACCOUNT_TEXT.passwordIntro}</span>}>
      <PasswordForm onCancel={() => setOpen(false)} onChanged={() => { onChanged(); setOpen(false); setSaved(ACCOUNT_TEXT.passwordChanged) }} now={now} />
    </FormCard>
  )
}

function UsernameForm({ onRenamed, onCancel, now }: { onRenamed: (u: AuthUser) => void; onCancel(): void; now: () => number }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const s = useAuthSubmit(now, accountErrorText(ACCOUNT_TEXT.wrongPassword))
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked) return
    if (username.trim() === '' || password === '') return s.setFailure({ message: ACCOUNT_TEXT.needUsername })
    s.setPending(true)
    s.setFailure(null)
    changeUsername(username.trim(), password).then(
      (r) => {
        const u = replyUser(r)
        if (!r.ok || !u) return s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
        onRenamed(u)
      },
      (err: unknown) => s.setFailure({ message: ACCOUNT_TEXT.failed('Changing the username', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} aria-label={ACCOUNT_TEXT.usernameTitle} className="st-form">
      <div className="flex w-full max-w-[400px] flex-col gap-2">
        <PasswordField id="account-new-username" label={ACCOUNT_TEXT.newUsername} autoComplete="username" value={username} onChange={setUsername} disabled={s.pending} />
        <PasswordField id="account-username-password" label={ACCOUNT_TEXT.password} autoComplete="current-password" value={password} onChange={setPassword} disabled={s.pending} />
      </div>
      <FormActions pending={s.pending} blocked={s.blocked} submit={ACCOUNT_TEXT.saveUsername} onCancel={onCancel} error={s.text} />
    </form>
  )
}

function PasswordForm({ onChanged, onCancel, now }: { onChanged: () => void; onCancel(): void; now: () => number }): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const s = useAuthSubmit(now, accountErrorText(ACCOUNT_TEXT.wrongCurrent))
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked) return
    if (current === '') return s.setFailure({ message: ACCOUNT_TEXT.needCurrent })
    if (charCount(next) < PASSWORD_MIN) return s.setFailure({ message: ACCOUNT_TEXT.weakPassword })
    if (next !== confirm) return s.setFailure({ message: ACCOUNT_TEXT.mismatch })
    s.setPending(true)
    s.setFailure(null)
    changePassword(current, next).then(
      (r) => {
        if (!r.ok) return s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
        onChanged()
      },
      (err: unknown) => s.setFailure({ message: ACCOUNT_TEXT.failed('Changing the password', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} aria-label={ACCOUNT_TEXT.passwordTitle} className="st-form">
      <div className="flex w-full max-w-[400px] flex-col gap-2">
        <PasswordField id="account-current-password" label={ACCOUNT_TEXT.currentPassword} autoComplete="current-password" value={current} onChange={setCurrent} disabled={s.pending} />
        <PasswordField
          id="account-new-password" label={ACCOUNT_TEXT.newPassword} autoComplete="new-password" value={next} onChange={setNext}
          disabled={s.pending} hint={SIGN_IN_TEXT.lengthHint(charCount(next))}
        />
        <PasswordField id="account-confirm-password" label={ACCOUNT_TEXT.confirmPassword} autoComplete="new-password" value={confirm} onChange={setConfirm} disabled={s.pending} />
      </div>
      <FormActions pending={s.pending} blocked={s.blocked} submit={ACCOUNT_TEXT.savePassword} onCancel={onCancel} error={s.text} />
    </form>
  )
}

/** Submit + Cancel and the form's one error line. Submit is off only while sending or counting down a 429
 *  (the countdown sentence says why); empty fields are named on submit instead. */
function FormActions({ pending, blocked, submit, onCancel, error }: { pending: boolean; blocked: boolean; submit: string; onCancel(): void; error: string | null }): React.JSX.Element {
  return (
    <>
      <div className="st-form-actions">
        <Button type="submit" size="sm" disabled={pending || blocked}>{pending ? ACCOUNT_TEXT.working : submit}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>{ACCOUNT_TEXT.cancel}</Button>
      </div>
      {error ? <p role="alert" className="st-state--error m-0 text-xs">{error}</p> : null}
    </>
  )
}
