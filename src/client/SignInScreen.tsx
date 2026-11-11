// What the desktop shows when this browser may not load the board: GET /auth/me picks the mode.
//   setupRequired + signed in (a window the server opened, or a token-era session) -> the account form
//   setupRequired, no proof -> "Open setup window on this computer", or the setup code from another device
//   account exists, signed out -> username + password, or "Open signed-in window" (local, passwordless)
// Pattern: code-server (password -> session cookie) plus Jupyter's redirect file for the local window.
// While visible the tab polls /auth/me: a window elsewhere that signs this browser in reloads it, and a
// setup window that signs it in shows the form here too. A reload keeps the path the user asked for.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import Brand from './Brand'
import { LoginForm, OpenWindowButton, SetupForm } from './SignInForms'
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

const MUTED = 'max-w-[440px] text-center text-xs text-[var(--vscode-descriptionForeground)]'

/** The signed-out page: sign in, or create the first account. */
export default function SignInScreen({ reload = reloadPage, now = Date.now }: SignInScreenProps) {
  const [me, setMe] = useState<AuthMe | null>(null)
  const [fatal, setFatal] = useState<{ message: string; retry: () => void } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  const alreadySetup = useCallback(() => { setNotice(SIGN_IN_TEXT.alreadySetup); check() }, [check])

  const shell = 'absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-auto bg-[var(--vscode-editor-background)] p-4 text-foreground'
  if (done || (me === null && fatal === null)) {
    return <div role="status" className={`${shell} text-[13px] text-[var(--vscode-descriptionForeground)]`}>{done ? SIGN_IN_TEXT.signedIn : SIGN_IN_TEXT.loading}</div>
  }
  const setup = !fatal && me?.setupRequired === true
  const proof = setup && me?.signedIn === true
  return (
    <div className={shell}>
      <Brand gradientId="signin-brand" />
      <h1 className="text-[15px] font-semibold">{setup ? SIGN_IN_TEXT.setupTitle : SIGN_IN_TEXT.title}</h1>
      {fatal ? (
        <div role="alert" className="flex flex-col items-center gap-2">
          <p className="max-w-[440px] text-center text-xs text-[var(--vscode-errorForeground)]">{fatal.message}</p>
          <Button type="button" variant="outline" onClick={fatal.retry}>{SIGN_IN_TEXT.retry}</Button>
        </div>
      ) : setup ? (
        <>
          <p className={MUTED}>{proof ? SIGN_IN_TEXT.setupIntroProof : SIGN_IN_TEXT.setupIntroNoProof}</p>
          {proof ? <SetupForm withCode={false} onDone={signedIn} onAlreadySetup={alreadySetup} now={now} /> : (
            <>
              <OpenWindowButton label={SIGN_IN_TEXT.openSetup} now={now} />
              <details className="flex w-[300px] max-w-full flex-col items-stretch gap-2 text-[13px]">
                <summary className="cursor-pointer text-center">{SIGN_IN_TEXT.otherDevice}</summary>
                <div className="mt-3"><SetupForm withCode onDone={signedIn} onAlreadySetup={alreadySetup} now={now} /></div>
              </details>
            </>
          )}
        </>
      ) : (
        <>
          {notice ? <p role="status" className={MUTED}>{notice}</p> : <p className={MUTED}>{SIGN_IN_TEXT.intro}</p>}
          <LoginForm onDone={signedIn} now={now} />
          <OpenWindowButton label={SIGN_IN_TEXT.open} variant="outline" now={now} />
        </>
      )}
      {offline ? <p role="status" className="text-xs text-[var(--vscode-errorForeground)]">{SIGN_IN_TEXT.offline}</p> : null}
    </div>
  )
}
