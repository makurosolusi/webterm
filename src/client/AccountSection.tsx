// Settings › Account (`?settings=account`): who is signed in, change username (needs the password),
// change password (signs every other session out, OWASP ASVS 3.3), and the sessions list, whose row for
// this device is the one Sign out (without an account, a lone Sign out button stands in for it).
// Server: src/server/routes/auth.account.routes.ts. Sentences: accountLabels.ts.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { changePassword, changeUsername, replyUser } from './account.api.client'
import { ACCOUNT_TEXT, accountErrorText } from './accountLabels'
import { AccountSessions } from './AccountSessions'
import { PasswordField } from './PasswordField'
import { charCount, PASSWORD_MIN, SIGN_IN_TEXT } from './signInLabels'
import { fetchMe, logout, type AuthUser } from './transportToken'
import { useAuthSubmit } from './useAuthSubmit'

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface AccountSectionProps {
  /** After Sign out; tests replace it. Default reloads to the sign-in page. */
  reload?: () => void
  now?: () => number
}

const defaultReload = (): void => location.reload()

/** The Account settings page. */
export function AccountSection({ reload = defaultReload, now = Date.now }: AccountSectionProps): React.JSX.Element {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionsKey, setSessionsKey] = useState(0)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    fetchMe().then((m) => setUser(m.user), (e: unknown) => setLoadError(ACCOUNT_TEXT.loadFailed(causeOf(e))))
  }, [])
  useEffect(load, [load])

  // Reload only on success: a refused sign-out keeps the page (and says so) rather than pretending.
  const signOut = useCallback(() => {
    setSignOutError(null)
    logout().then(reload, (e: unknown) => setSignOutError(ACCOUNT_TEXT.failed('Signing out', causeOf(e))))
  }, [reload])

  if (loadError) {
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
        <span>{loadError}</span>
        <Button size="sm" variant="outline" onClick={load}>{ACCOUNT_TEXT.retry}</Button>
      </div>
    )
  }
  if (user === undefined) return <p role="status" className="text-xs opacity-70">{ACCOUNT_TEXT.loading}</p>
  return (
    <div className="flex max-w-[520px] flex-col gap-6">
      {user ? (
        <>
          <p className="text-[13px]">{ACCOUNT_TEXT.signedInAs} <strong data-testid="account-username">{user.username}</strong></p>
          <UsernameForm onRenamed={setUser} now={now} />
          <PasswordForm onChanged={() => setSessionsKey((k) => k + 1)} now={now} />
          {/* The one Sign out with an account: this device's row in the sessions list. */}
          <AccountSessions refreshKey={sessionsKey} onSignOutHere={signOut} now={now} />
        </>
      ) : (
        <>
          <p className="text-[13px]">{ACCOUNT_TEXT.noAccount}</p>
          <section aria-labelledby="account-signout-title" className="flex flex-col items-start gap-2">
            <h4 id="account-signout-title" className="text-[13px] font-semibold">{ACCOUNT_TEXT.signOutTitle}</h4>
            <p className="text-xs opacity-70">{ACCOUNT_TEXT.signOutIntro}</p>
            <Button size="sm" variant="outline" onClick={signOut}>{ACCOUNT_TEXT.signOut}</Button>
          </section>
        </>
      )}
      {signOutError ? <p role="alert" className="text-xs text-destructive">{signOutError}</p> : null}
    </div>
  )
}

function UsernameForm({ onRenamed, now }: { onRenamed: (u: AuthUser) => void; now: () => number }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState(false)
  const s = useAuthSubmit(now, accountErrorText(ACCOUNT_TEXT.wrongPassword))
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked || username.trim() === '' || password === '') return
    s.setPending(true)
    s.setFailure(null)
    setSaved(false)
    changeUsername(username.trim(), password).then(
      (r) => {
        const u = replyUser(r)
        if (!r.ok || !u) return s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
        onRenamed(u)
        setUsername('')
        setPassword('')
        setSaved(true)
      },
      (err: unknown) => s.setFailure({ message: ACCOUNT_TEXT.failed('Changing the username', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} aria-labelledby="account-username-title" className="flex flex-col items-start gap-2">
      <h4 id="account-username-title" className="text-[13px] font-semibold">{ACCOUNT_TEXT.usernameTitle}</h4>
      <PasswordField id="account-new-username" label={ACCOUNT_TEXT.newUsername} autoComplete="username" value={username} onChange={setUsername} disabled={s.pending} />
      <PasswordField id="account-username-password" label={ACCOUNT_TEXT.password} autoComplete="current-password" value={password} onChange={setPassword} disabled={s.pending} />
      <Button type="submit" size="sm" disabled={s.pending || s.blocked || username.trim() === '' || password === ''}>{s.pending ? ACCOUNT_TEXT.working : ACCOUNT_TEXT.saveUsername}</Button>
      {s.text ? <p role="alert" className="text-xs text-destructive">{s.text}</p> : null}
      {saved ? <p role="status" className="text-xs opacity-70">{ACCOUNT_TEXT.usernameChanged}</p> : null}
    </form>
  )
}

function PasswordForm({ onChanged, now }: { onChanged: () => void; now: () => number }): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saved, setSaved] = useState(false)
  const s = useAuthSubmit(now, accountErrorText(ACCOUNT_TEXT.wrongCurrent))
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (s.pending || s.blocked || current === '') return
    setSaved(false)
    if (charCount(next) < PASSWORD_MIN) return s.setFailure({ message: ACCOUNT_TEXT.weakPassword })
    if (next !== confirm) return s.setFailure({ message: ACCOUNT_TEXT.mismatch })
    s.setPending(true)
    s.setFailure(null)
    changePassword(current, next).then(
      (r) => {
        if (!r.ok) return s.setFailure({ status: r.status, error: r.error, retryAfterS: r.retryAfterS })
        setCurrent('')
        setNext('')
        setConfirm('')
        setSaved(true)
        onChanged()
      },
      (err: unknown) => s.setFailure({ message: ACCOUNT_TEXT.failed('Changing the password', causeOf(err)) }),
    ).finally(() => s.setPending(false))
  }
  return (
    <form onSubmit={submit} aria-labelledby="account-password-title" className="flex flex-col items-start gap-2">
      <h4 id="account-password-title" className="text-[13px] font-semibold">{ACCOUNT_TEXT.passwordTitle}</h4>
      <PasswordField id="account-current-password" label={ACCOUNT_TEXT.currentPassword} autoComplete="current-password" value={current} onChange={setCurrent} disabled={s.pending} />
      <PasswordField
        id="account-new-password" label={ACCOUNT_TEXT.newPassword} autoComplete="new-password" value={next} onChange={setNext}
        disabled={s.pending} hint={SIGN_IN_TEXT.lengthHint(charCount(next))}
      />
      <PasswordField id="account-confirm-password" label={ACCOUNT_TEXT.confirmPassword} autoComplete="new-password" value={confirm} onChange={setConfirm} disabled={s.pending} />
      <Button type="submit" size="sm" disabled={s.pending || s.blocked || current === ''}>{s.pending ? ACCOUNT_TEXT.working : ACCOUNT_TEXT.savePassword}</Button>
      {s.text ? <p role="alert" className="text-xs text-destructive">{s.text}</p> : null}
      {saved ? <p role="status" className="text-xs opacity-70">{ACCOUNT_TEXT.passwordChanged}</p> : null}
    </form>
  )
}
