// /m shell: four tabs (Brief, Inbox, Agents, Timeline) chosen by the URL hash, so a notification
// tap (`/m/#inbox`) lands on the right screen. A server answering 401/403 shows the account sign-in
// (username + password, POST /auth/login -> the `wt_ui` session cookie an installed PWA keeps across
// launches); before the first account exists it shows the same create-account form as the desktop.
import { useCallback, useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { InboxApiError } from '../inboxTypes'
import { request } from '../inboxTransport'
import { MobileAgents } from './MobileAgents'
import { MobileBrief, MobileTimeline } from './MobileFeeds'
import { MobileInbox } from './MobileInbox'
import { MobilePushCard } from './MobilePushCard'
import { LoginForm } from '../SignInForms'
import { SetupForm } from '../signIn/SetupForm'
import { SIGN_IN_TEXT } from '../signInLabels'
import { fetchMe, logout } from '../transportToken'

export const TABS = [
  { id: 'brief', label: 'Brief' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'agents', label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
] as const
export type TabId = (typeof TABS)[number]['id']

export const tabFromHash = (hash: string): TabId => TABS.find((t) => `#${t.id}` === hash)?.id ?? 'inbox'

type Auth = 'checking' | 'ok' | 'needed'

/** Sign-in for /m: the desktop's LoginForm, or its SetupForm before the first account exists. */
function SignIn({ reload }: { reload: () => void }): React.JSX.Element {
  const [setup, setSetup] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const check = useCallback(() => {
    fetchMe().then((m) => setSetup(m.setupRequired), (err: unknown) => {
      setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`)
      setSetup(false) // still offer the form: it reports its own failure if the server stays away
    })
  }, [])
  useEffect(check, [check])
  return (
    <main className="m-signin">
      <h1>webterm</h1>
      {setup === null ? <p role="status">{SIGN_IN_TEXT.loading}</p>
        : setup ? <><p>{SIGN_IN_TEXT.setupIntro}</p><SetupForm onDone={reload} onAlreadySetup={check} /></>
          : <><p>{SIGN_IN_TEXT.intro}</p><LoginForm idPrefix="m-signin" onDone={reload} /></>}
      {error && <p className="m-error" role="alert">{error}</p>}
    </main>
  )
}

/** Signs out and reloads into the sign-in screen; a failure stays on screen with Retry (still signed in). */
async function signOut(): Promise<void> {
  await logout()
  location.reload()
}

const reloadPage = (): void => location.reload()

/** The /m shell; `reload` (after sign-in) is replaced by tests. */
export function MobileApp({ reload = reloadPage }: { reload?: () => void } = {}): React.JSX.Element {
  const [tab, setTab] = useState<TabId>(() => tabFromHash(location.hash))
  const [auth, setAuth] = useState<Auth>('checking')
  const signOutAct = useAction(signOut, { label: 'Sign out' })

  useEffect(() => {
    const onHash = () => setTab(tabFromHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    request('/api/workspaces').then(() => setAuth('ok'), (err: unknown) => {
      setAuth(err instanceof InboxApiError && (err.status === 401 || err.status === 403) ? 'needed' : 'ok')
    })
  }, [])

  if (auth === 'needed') return <SignIn reload={reload} />
  if (auth === 'checking') return <main className="m-app" aria-busy="true" />

  return (
    <div className="m-app">
      <header className="m-header">
        <h1>{TABS.find((t) => t.id === tab)!.label}</h1>
        <ActionButton type="button" className="m-link" action={signOutAct} busyLabel="Signing out…">Sign out</ActionButton>
      </header>
      <ActionResult action={signOutAct} />
      <main className="m-main">
        {tab === 'brief' && <MobileBrief />}
        {tab === 'inbox' && <><MobilePushCard /><MobileInbox /></>}
        {tab === 'agents' && <MobileAgents />}
        {tab === 'timeline' && <MobileTimeline />}
      </main>
      <nav className="m-tabs" aria-label="Screens">
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} aria-current={t.id === tab ? 'page' : undefined} className="m-tab">{t.label}</a>
        ))}
      </nav>
    </div>
  )
}
