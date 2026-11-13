// Settings › Account › Signed-in devices: the caller's own signed-in browsers (GET /auth/sessions), this one
// marked, each with last active and signed-in times and "Sign out", plus "Sign out all other devices"; every
// sign-out asks first (AlertDialog). Pattern: GitHub / Google "Your devices". Signing this device out ends the
// session here and reloads to the sign-in page.
import { useCallback, useEffect, useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { CardEmpty, CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { fetchSessions, revokeOtherSessions, revokeSession, type AuthSession } from './account.api.client'
import { ACCOUNT_TEXT, browserLabel, relativeTime } from './accountLabels'

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface AccountSessionsProps {
  /** Bumped by the parent after a password change, which signs every other session out. */
  refreshKey: number
  /** Sign this browser out (POST /auth/logout + reload). */
  onSignOutHere: () => void
  /** That sign-out is running (the page reloads after it). */
  signingOut?: boolean
  now?: () => number
}

/** The sessions list with per-row and bulk sign-out; loading, empty and error states. */
type Asking = { kind: 'one'; s: AuthSession } | { kind: 'here' } | { kind: 'others' }

export function AccountSessions({ refreshKey, onSignOutHere, signingOut = false, now = Date.now }: AccountSessionsProps): React.JSX.Element {
  const [asking, setAsking] = useState<Asking | null>(null)
  const [items, setItems] = useState<AuthSession[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    fetchSessions().then(setItems, (e: unknown) => setLoadError(ACCOUNT_TEXT.sessionsFailed(causeOf(e))))
  }, [])
  useEffect(load, [load, refreshKey])

  const act = (key: string, run: () => Promise<string>): void => {
    setBusy(key)
    setMessage(null)
    run().then(
      (text) => setMessage({ text, error: false }),
      (e: unknown) => setMessage({ text: ACCOUNT_TEXT.failed('Signing out', causeOf(e)), error: true }),
    ).finally(() => { setBusy(null); load() })
  }
  const revokeOne = (s: AuthSession): void => act(s.id, async () => {
    const r = await revokeSession(s.id)
    if (r.status === 404) return ACCOUNT_TEXT.rowGone
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return ACCOUNT_TEXT.signedOutOne(browserLabel(s.ua))
  })
  const revokeOthers = (): void => act('others', async () => {
    const r = await revokeOtherSessions()
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return ACCOUNT_TEXT.signedOutOthers(typeof r.body?.revoked === 'number' ? r.body.revoked : 0)
  })

  const others = items?.filter((s) => !s.current).length ?? 0
  const confirm = (): void => {
    const a = asking
    setAsking(null)
    if (a?.kind === 'one') revokeOne(a.s)
    else if (a?.kind === 'here') onSignOutHere()
    else if (a?.kind === 'others') revokeOthers()
  }
  const dialog = asking?.kind === 'one' ? { title: ACCOUNT_TEXT.confirmOneTitle(browserLabel(asking.s.ua)), body: ACCOUNT_TEXT.confirmOneBody }
    : asking?.kind === 'here' ? { title: ACCOUNT_TEXT.confirmHereTitle, body: ACCOUNT_TEXT.confirmHereBody }
      : asking?.kind === 'others' ? { title: ACCOUNT_TEXT.confirmOthersTitle(others), body: ACCOUNT_TEXT.confirmOthersBody } : null
  const locked = busy !== null || signingOut

  return (
    <SettingsGroup title={ACCOUNT_TEXT.sessionsTitle} description={ACCOUNT_TEXT.sessionsIntro}>
      {loadError ? <CardError text={loadError} onRetry={load} />
        : items === null ? <CardLoading text={ACCOUNT_TEXT.sessionsLoading} />
          : items.length === 0 ? <CardEmpty text={ACCOUNT_TEXT.sessionsEmpty} /> : (
            <ul aria-label={ACCOUNT_TEXT.sessionsTitle} className="st-list">
              {items.map((s) => {
                const browser = browserLabel(s.ua)
                return (
                  <li key={s.id} className="st-field" data-current={s.current || undefined}>
                    <div className="st-field-text">
                      <span className="st-row-title">
                        <span className="codicon codicon-device-desktop mr-1.5 align-[-2px]" aria-hidden="true" />
                        {browser}
                        {s.current ? <span className="st-chip">{ACCOUNT_TEXT.thisDevice}</span> : null}
                      </span>
                      <p className="st-row-meta">{ACCOUNT_TEXT.lastActive(relativeTime(s.lastSeen, now()))} · {ACCOUNT_TEXT.signedInAt(relativeTime(s.createdAt, now()))}</p>
                    </div>
                    <div className="st-control">
                      <Button
                        size="sm" variant="outline" disabled={locked} aria-label={ACCOUNT_TEXT.signOutRowLabel(s.current ? `${browser} (${ACCOUNT_TEXT.thisDevice})` : browser)}
                        onClick={() => setAsking(s.current ? { kind: 'here' } : { kind: 'one', s })}
                      >{busy === s.id || (s.current && signingOut) ? ACCOUNT_TEXT.working : ACCOUNT_TEXT.signOutRow}</Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      {items !== null && items.length > 0 ? (
        <div className="st-field">
          <div className="st-field-text"><p className="st-row-meta">{others === 0 ? ACCOUNT_TEXT.noOthers : ACCOUNT_TEXT.othersCount(others)}</p></div>
          {others > 0 ? (
            <div className="st-control">
              <Button size="sm" variant="outline" disabled={locked} onClick={() => setAsking({ kind: 'others' })}>
                {busy === 'others' ? ACCOUNT_TEXT.working : ACCOUNT_TEXT.signOutOthers}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {message?.text ? <p role={message.error ? 'alert' : 'status'} className={`st-state${message.error ? ' st-state--error' : ''}`}>{message.text}</p> : null}
      {dialog ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setAsking(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
              <AlertDialogDescription>{dialog.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{ACCOUNT_TEXT.cancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirm}>{ACCOUNT_TEXT.signOutRow}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </SettingsGroup>
  )
}
