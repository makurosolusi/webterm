// Settings › Account › Sessions: the caller's own signed-in browsers (GET /auth/sessions), this one
// marked, each with "Sign out", plus "Sign out all other sessions". Pattern: GitHub / Google "Your
// devices". Signing this device out ends the session here and reloads to the sign-in page.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fetchSessions, revokeOtherSessions, revokeSession, type AuthSession } from './account.api.client'
import { ACCOUNT_TEXT, browserLabel, relativeTime } from './accountLabels'

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface AccountSessionsProps {
  /** Bumped by the parent after a password change, which signs every other session out. */
  refreshKey: number
  /** Sign this browser out (POST /auth/logout + reload). */
  onSignOutHere: () => void
  now?: () => number
}

/** The sessions list with per-row and bulk sign-out; loading, empty and error states. */
export function AccountSessions({ refreshKey, onSignOutHere, now = Date.now }: AccountSessionsProps): React.JSX.Element {
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
    return ''
  })
  const revokeOthers = (): void => act('others', async () => {
    const r = await revokeOtherSessions()
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return ACCOUNT_TEXT.signedOutOthers(typeof r.body?.revoked === 'number' ? r.body.revoked : 0)
  })

  const others = items?.filter((s) => !s.current).length ?? 0
  return (
    <section aria-labelledby="account-sessions-title" className="flex flex-col gap-2">
      <h4 id="account-sessions-title" className="text-[13px] font-semibold">{ACCOUNT_TEXT.sessionsTitle}</h4>
      <p className="text-xs opacity-70">{ACCOUNT_TEXT.sessionsIntro}</p>
      {loadError ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span>{loadError}</span>
          <Button size="sm" variant="outline" onClick={load}>{ACCOUNT_TEXT.retry}</Button>
        </div>
      ) : items === null ? <p role="status" className="text-xs opacity-70">{ACCOUNT_TEXT.sessionsLoading}</p>
        : items.length === 0 ? <p className="text-xs opacity-70">{ACCOUNT_TEXT.sessionsEmpty}</p> : (
          <ul aria-label={ACCOUNT_TEXT.sessionsTitle} className="flex flex-col gap-1">
            {items.map((s) => {
              const browser = browserLabel(s.ua)
              return (
                <li key={s.id} className="flex items-center justify-between gap-3 rounded border border-(--vscode-widget-border) px-2 py-1.5">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[13px]">
                      {browser}
                      {s.current ? <span className="ml-2 rounded bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)">{ACCOUNT_TEXT.thisDevice}</span> : null}
                    </span>
                    <span className="text-xs opacity-70">{ACCOUNT_TEXT.lastActive(relativeTime(s.lastSeen, now()))}</span>
                  </div>
                  <Button
                    size="sm" variant="outline" disabled={busy !== null} aria-label={ACCOUNT_TEXT.signOutRowLabel(s.current ? `${browser} (${ACCOUNT_TEXT.thisDevice})` : browser)}
                    onClick={() => (s.current ? onSignOutHere() : revokeOne(s))}
                  >{ACCOUNT_TEXT.signOutRow}</Button>
                </li>
              )
            })}
          </ul>
        )}
      {items !== null ? (
        <div>
          <Button size="sm" variant="outline" disabled={busy !== null || others === 0} onClick={revokeOthers}>{ACCOUNT_TEXT.signOutOthers}</Button>
        </div>
      ) : null}
      {message?.text ? <p role={message.error ? 'alert' : 'status'} className={`text-xs ${message.error ? 'text-destructive' : 'opacity-70'}`}>{message.text}</p> : null}
    </section>
  )
}
