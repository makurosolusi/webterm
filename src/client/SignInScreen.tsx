// What App shows when the server refuses this browser (the boot fetch answers 401/403): the way to
// get the HttpOnly `wt_ui` session cookie (transportToken.ts). Two ways in, like Jupyter and VS Code
// server: ask the server to open a signed-in window on its own machine (the one-time code travels
// through a file only the user can read, never through this page), or paste the access token for
// remote/headless use. While signed out and visible, the tab polls GET /auth/me and reloads once a
// window elsewhere has signed this browser in.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Brand from './Brand'
import { fetchSignedIn, loginWithToken, requestOpen } from './transportToken'

export const SIGN_IN_POLL_MS = 2000
const COUNTDOWN_TICK_MS = 1000
const HTTP_NO_CONTENT = 204
const HTTP_ACCEPTED = 202
const HTTP_FORBIDDEN = 403
const HTTP_CONFLICT = 409
const HTTP_TOO_MANY = 429

export const SIGN_IN_TEXT = {
  loading: 'Checking sign-in…',
  title: 'Sign in to webterm',
  intro: 'This browser is not signed in. Open a signed-in window on the computer running webterm, or paste the access token.',
  open: 'Open signed-in window',
  opening: 'A signed-in webterm window is opening on the computer running webterm. This tab reloads by itself once you are signed in.',
  rateLimited: (s: number) => `A window was just opened. You can ask again in ${s} s.`,
  tokenLabel: 'Access token',
  tokenPlaceholder: 'access token',
  tokenHint: 'Found in the secrets folder of the webterm data directory (WEBTERM_TOKEN).',
  showToken: 'Show token',
  hideToken: 'Hide token',
  signIn: 'Sign in',
  wrongToken: 'That token was not accepted.',
  noToken: 'This server has no access token. Use "Open signed-in window" instead.',
  signedIn: 'Signed in. Loading webterm…',
  offline: 'Cannot reach the server. Still checking every 2 s.',
  stillRefused: 'This browser is signed in, but the server still refused to load the workspaces. Reload to try again.',
  retry: 'Retry',
  failed: (what: string, cause: string) => `${what} failed: ${cause}`,
} as const

type Phase =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'opening' }
  | { kind: 'rateLimited'; until: number }
  | { kind: 'error'; message: string; retry: () => void }
  | { kind: 'signedIn' }

/** Module-level so the default is one stable function: an inline default would re-run every effect that depends on it. */
const reloadPage = (): void => location.reload()

const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface SignInScreenProps {
  /** Called once when this browser becomes signed in; tests replace it. */
  reload?: () => void
  now?: () => number
}

export default function SignInScreen({ reload = reloadPage, now = Date.now }: SignInScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [offline, setOffline] = useState(false)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [, tick] = useState(0)
  const reloaded = useRef(false)

  const signedIn = useCallback(() => {
    setPhase({ kind: 'signedIn' })
    if (!reloaded.current) { reloaded.current = true; reload() }
  }, [reload])

  // Initial check. Already signed in here means the refusal is not about the cookie: say so, do
  // not reload (a reload would only meet the same refusal, in a loop).
  const check = useCallback(() => {
    setPhase({ kind: 'loading' })
    fetchSignedIn().then(
      (yes) => setPhase(yes ? { kind: 'error', message: SIGN_IN_TEXT.stillRefused, retry: reload } : { kind: 'signedOut' }),
      (e: unknown) => setPhase({ kind: 'error', message: SIGN_IN_TEXT.failed('Checking sign-in', causeOf(e)), retry: check }),
    )
  }, [reload])
  useEffect(check, [check])

  const polling = phase.kind === 'signedOut' || phase.kind === 'opening' || phase.kind === 'rateLimited'
  useEffect(() => {
    if (!polling) return
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      fetchSignedIn().then(
        (yes) => { setOffline(false); if (yes) signedIn() },
        () => setOffline(true), // shown as the `offline` line; the next tick tries again
      )
    }
    // Coming back to this tab (the signed-in window opened in front of it) checks at once.
    const timer = setInterval(poll, SIGN_IN_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [polling, signedIn])

  const until = phase.kind === 'rateLimited' ? phase.until : 0
  useEffect(() => {
    if (until === 0) return
    const timer = setInterval(() => {
      if (now() >= until) setPhase((p) => (p.kind === 'rateLimited' ? { kind: 'signedOut' } : p))
      else tick((n) => n + 1)
    }, COUNTDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [until, now])

  const open = useCallback(() => {
    setPending(true)
    requestOpen().then(
      ({ status, retryAfterS }) => {
        if (status === HTTP_ACCEPTED) setPhase({ kind: 'opening' })
        else if (status === HTTP_TOO_MANY) setPhase({ kind: 'rateLimited', until: now() + retryAfterS * 1000 })
        else setPhase({ kind: 'error', message: SIGN_IN_TEXT.failed('Opening a signed-in window', `HTTP ${status}`), retry: open })
      },
      (e: unknown) => setPhase({ kind: 'error', message: SIGN_IN_TEXT.failed('Opening a signed-in window', causeOf(e)), retry: open }),
    ).finally(() => setPending(false))
  }, [now])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const value = token.trim()
    if (value === '' || pending) return
    setPending(true)
    setTokenError(null)
    loginWithToken(value).then(
      (status) => {
        if (status === HTTP_NO_CONTENT) return signedIn()
        if (status === HTTP_FORBIDDEN) setTokenError(SIGN_IN_TEXT.wrongToken)
        else if (status === HTTP_CONFLICT) setTokenError(SIGN_IN_TEXT.noToken)
        else setTokenError(SIGN_IN_TEXT.failed('Signing in', `HTTP ${status}`))
      },
      (err: unknown) => setTokenError(SIGN_IN_TEXT.failed('Signing in', causeOf(err))),
    ).finally(() => setPending(false))
  }

  const shell = 'absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--vscode-editor-background)] text-foreground'
  const muted = 'max-w-[440px] text-center text-xs text-[var(--vscode-descriptionForeground)]'
  if (phase.kind === 'loading' || phase.kind === 'signedIn') {
    return <div role="status" className={`${shell} text-[13px] text-[var(--vscode-descriptionForeground)]`}>{phase.kind === 'loading' ? SIGN_IN_TEXT.loading : SIGN_IN_TEXT.signedIn}</div>
  }
  return (
    <div className={shell}>
      <Brand gradientId="signin-brand" />
      <h1 className="text-[15px] font-semibold">{SIGN_IN_TEXT.title}</h1>
      <p className={muted}>{SIGN_IN_TEXT.intro}</p>
      {phase.kind === 'error' ? (
        <div role="alert" className="flex flex-col items-center gap-2">
          <p className="max-w-[440px] text-center text-xs text-[var(--vscode-errorForeground)]">{phase.message}</p>
          <Button type="button" variant="outline" onClick={phase.retry}>{SIGN_IN_TEXT.retry}</Button>
        </div>
      ) : null}
      <Button type="button" disabled={pending || phase.kind === 'rateLimited'} onClick={open}>{SIGN_IN_TEXT.open}</Button>
      {phase.kind === 'opening' ? <p role="status" className={muted}>{SIGN_IN_TEXT.opening}</p> : null}
      {phase.kind === 'rateLimited' ? (
        <p role="status" className={muted}>{SIGN_IN_TEXT.rateLimited(Math.max(1, Math.ceil((phase.until - now()) / 1000)))}</p>
      ) : null}
      {offline ? <p role="status" className="text-xs text-[var(--vscode-errorForeground)]">{SIGN_IN_TEXT.offline}</p> : null}
      <form onSubmit={submit} className="mt-2 flex flex-col items-center gap-2">
        <Label htmlFor="signin-access-token" className="text-[13px] font-normal text-[var(--vscode-descriptionForeground)]">{SIGN_IN_TEXT.tokenLabel}</Label>
        <div className="flex items-center gap-1">
          <Input
            id="signin-access-token" className="h-auto w-[260px] text-center focus-visible:ring-0"
            type={showToken ? 'text' : 'password'} autoComplete="off" placeholder={SIGN_IN_TEXT.tokenPlaceholder}
            value={token} disabled={pending} onChange={(e) => setToken(e.target.value)}
          />
          <IconButton
            type="button" size="icon-sm" label={showToken ? SIGN_IN_TEXT.hideToken : SIGN_IN_TEXT.showToken}
            aria-pressed={showToken} onClick={() => setShowToken((v) => !v)}
          ><span className={`codicon ${showToken ? 'codicon-eye-closed' : 'codicon-eye'}`} aria-hidden="true" /></IconButton>
        </div>
        <p className={muted}>{SIGN_IN_TEXT.tokenHint}</p>
        <Button type="submit" variant="outline" disabled={pending || token.trim() === ''}>{SIGN_IN_TEXT.signIn}</Button>
        {tokenError ? <div role="alert" className="text-xs text-[var(--vscode-errorForeground)]">{tokenError}</div> : null}
      </form>
    </div>
  )
}
