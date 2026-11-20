// What the desktop shows when this browser may not load the board: GET /auth/me picks the mode.
//   setupRequired -> the create-account form (no proof of any kind; the server takes username + password)
//   account exists, signed out -> username + password, or "Open signed-in window" (local, passwordless)
// Pattern: code-server (password -> session cookie) plus Jupyter's redirect file for the local window.
// While visible the tab polls /auth/me: a window elsewhere that signs this browser in reloads it. A reload keeps the path the user asked for.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import Brand from './Brand'
import { FormAlert } from './signIn/authFormParts'
import { SetupForm } from './signIn/SetupForm'
import { LoginForm, OpenWindowButton } from './SignInForms'
import { SIGN_IN_TEXT } from './signInLabels'
import { fetchMe, type AuthMe } from './transportToken'

export { SIGN_IN_TEXT } from './signInLabels'
export const SIGN_IN_POLL_MS = 2000

/** Module-level so the default is one stable function: an inline default would re-run every effect that depends on it. */
const reloadPage = (): void => location.reload()

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** Signed in to an account: the board may load (a token-era session during setup is not enough). */
const entered = (m: AuthMe): boolean => m.signedIn && !m.setupRequired

export interface SignInScreenProps {
  /** Called once when this browser becomes signed in; tests replace it. */
  reload?: () => void
  now?: () => number
}

const MUTED = 'text-center text-xs break-words text-[var(--vscode-descriptionForeground)] text-balance'
const SHELL = 'absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-auto bg-[var(--vscode-editor-background)] p-4 text-foreground'

/** The ~400px card every signed-out state sits in: logo, title, one-line subtitle, then the body. */
function AuthCard({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <Card className="w-full max-w-[400px] min-w-0 gap-6 px-4 py-8 shadow-sm sm:px-8">
      <header className="flex flex-col items-center gap-2">
        <div className="sign-in-brand mb-2"><Brand gradientId="signin-brand" /></div>
        <h1 className="text-center text-[18px] leading-6 font-semibold">{title}</h1>
        {subtitle}
      </header>
      {children}
    </Card>
  )
}

/** The signed-out page: sign in, or create the first account. */
export default function SignInScreen({ reload = reloadPage, now = Date.now }: SignInScreenProps) {
  const [me, setMe] = useState<AuthMe | null>(null)
  const [fatal, setFatal] = useState<{ message: string; retry: () => void } | null>(null)
  const [offline, setOffline] = useState(false)
  const [done, setDone] = useState(false)
  const reloaded = useRef(false)

  const signedIn = useCallback(() => {
    setDone(true)
    if (!reloaded.current) { reloaded.current = true; reload() }
  }, [reload])

  // Already in at mount means the refusal is not about the cookie: say so, never reload in a loop.
  const check = useCallback(() => {
    setMe(null)
    setFatal(null)
    fetchMe().then(
      (m) => { if (entered(m)) setFatal({ message: SIGN_IN_TEXT.stillRefused, retry: reload }); setMe(m) },
      (e: unknown) => setFatal({ message: SIGN_IN_TEXT.failed('Checking sign-in', causeOf(e)), retry: check }),
    )
  }, [reload])
  useEffect(check, [check])

  const polling = me !== null && fatal === null && !done
  useEffect(() => {
    if (!polling) return
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      fetchMe().then(
        (m) => { setOffline(false); if (entered(m)) signedIn(); else setMe(m) },
        () => setOffline(true), // shown as the `offline` line; the next tick tries again
      )
    }
    // Coming back to this tab (the signed-in window opened in front of it) checks at once.
    const timer = setInterval(poll, SIGN_IN_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [polling, signedIn])

  if (done || (me === null && fatal === null)) {
    return (
      <div role="status" className={`${SHELL} flex-row text-[13px] text-[var(--vscode-descriptionForeground)]`}>
        <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{done ? SIGN_IN_TEXT.signedIn : SIGN_IN_TEXT.loading}
      </div>
    )
  }
  const setup = !fatal && me?.setupRequired === true
  const subtitle = fatal ? null : <p className={MUTED}>{setup ? SIGN_IN_TEXT.setupIntro : SIGN_IN_TEXT.intro}</p>
  return (
    <main className={SHELL}>
      <AuthCard title={setup ? SIGN_IN_TEXT.setupTitle : SIGN_IN_TEXT.title} subtitle={subtitle}>
        {fatal ? (
          <div className="flex flex-col gap-4">
            <FormAlert text={fatal.message} />
            <Button type="button" variant="outline" className="h-11 w-full text-base" onClick={fatal.retry}>{SIGN_IN_TEXT.retry}</Button>
          </div>
        ) : setup ? (
          <SetupForm onDone={signedIn} onAlreadySetup={check} now={now} />
        ) : (
          <>
            <LoginForm onDone={signedIn} now={now} />
            <div className="flex items-center gap-3 text-xs text-[var(--vscode-descriptionForeground)]" aria-hidden="true">
              <span className="h-px flex-1 bg-(--vscode-editorWidget-border)" />{SIGN_IN_TEXT.or}<span className="h-px flex-1 bg-(--vscode-editorWidget-border)" />
            </div>
            <OpenWindowButton label={SIGN_IN_TEXT.open} variant="outline" now={now} />
          </>
        )}
      </AuthCard>
      {setup && !fatal ? (
        <p className={`${MUTED} flex max-w-[400px] items-center justify-center gap-1.5`}>
          <span className="codicon codicon-lock shrink-0" aria-hidden="true" />{SIGN_IN_TEXT.localNote}
        </p>
      ) : null}
      {offline ? <p role="status" className="text-xs text-[var(--vscode-errorForeground)]">{SIGN_IN_TEXT.offline}</p> : null}
    </main>
  )
}
