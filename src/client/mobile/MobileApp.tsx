// /m shell: four tabs (Brief, Inbox, Agents, Timeline) chosen by the URL hash, so a notification
// tap (`/m/#inbox`) lands on the right screen. A token-protected server without a stored token
// shows the sign-in field instead (the same check the desktop login uses: GET /api/workspaces).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TOKEN_HEADER } from '../api'
import { InboxApiError } from '../inboxTypes'
import { request } from '../inboxTransport'
import { MobileAgents } from './MobileAgents'
import { MobileBrief, MobileTimeline } from './MobileFeeds'
import { MobileInbox } from './MobileInbox'
import { MobilePushCard } from './MobilePushCard'
import { forgetToken, saveToken } from './mobile.token'

export const TABS = [
  { id: 'brief', label: 'Brief' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'agents', label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
] as const
export type TabId = (typeof TABS)[number]['id']

export const tabFromHash = (hash: string): TabId => TABS.find((t) => `#${t.id}` === hash)?.id ?? 'inbox'

type Auth = 'checking' | 'ok' | 'needed'

function SignIn(): React.JSX.Element {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const res = await fetch('/api/workspaces', { headers: { [TOKEN_HEADER]: token.trim() } }).catch(() => null)
    if (!res?.ok) { setError(res ? 'That token was not accepted.' : 'Could not reach the server.'); return }
    saveToken(token.trim())
    location.reload()
  }
  return (
    <main className="m-signin">
      <h1>webterm</h1>
      <p>This server needs its access token. Open the link with <code>?token=</code> from the desktop, or paste the token here.</p>
      <Input type="password" autoComplete="off" aria-label="Access token" value={token} onChange={(e) => setToken(e.target.value)} />
      <Button type="button" className="m-btn m-primary" disabled={!token.trim()} onClick={() => void submit()}>Sign in</Button>
      {error && <p className="m-error" role="alert">{error}</p>}
    </main>
  )
}

export function MobileApp(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>(() => tabFromHash(location.hash))
  const [auth, setAuth] = useState<Auth>('checking')

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

  if (auth === 'needed') return <SignIn />
  if (auth === 'checking') return <main className="m-app" aria-busy="true" />

  return (
    <div className="m-app">
      <header className="m-header">
        <h1>{TABS.find((t) => t.id === tab)!.label}</h1>
        <Button type="button" className="m-link" onClick={() => { forgetToken(); location.reload() }}>Sign out</Button>
      </header>
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
