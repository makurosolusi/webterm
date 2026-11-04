// Notifications switch for /m: one tap to subscribe (the server holds the VAPID key), a test
// button, and plain instructions when this browser cannot get there (HTTP, iOS outside the app).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { inboxErrorMessage } from '../inboxApi'
import { browserPushEnv, disablePush, enablePush, pushSupport, sendTestPush, SUPPORT_TEXT, syncPush, type PushSupport } from './mobile.push'

type State = 'checking' | 'off' | 'on' | 'denied'

export function MobilePushCard(props: { support?: PushSupport }): React.JSX.Element {
  const support = props.support ?? pushSupport(browserPushEnv())
  const [state, setState] = useState<State>('checking')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (support !== 'ok') return
    if (Notification.permission === 'denied') { setState('denied'); return }
    syncPush().then((on) => setState(on ? 'on' : 'off'), (err: unknown) => { setState('off'); setNote(inboxErrorMessage(err)) })
  }, [support])

  if (support !== 'ok') return <aside className="m-card m-push"><div className="m-card-kind">Notifications</div><p className="m-card-body">{SUPPORT_TEXT[support]}</p></aside>

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setNote(null)
    try { await fn() } catch (err) { setNote(inboxErrorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <aside className="m-card m-push">
      <div className="m-card-kind">Notifications</div>
      {state === 'denied' && <p className="m-card-body">Notifications are blocked for this site. Allow them in the browser or system settings, then reload.</p>}
      {state === 'off' && <p className="m-card-body">Get a notification when an agent needs approval or input, and when the morning brief is ready. Nothing is sent while you are looking at that agent on the desktop.</p>}
      {state === 'on' && <p className="m-card-body">On for this device.</p>}
      <div className="m-actions">
        {state === 'off' && <Button type="button" className="m-btn m-primary" disabled={busy} onClick={() => void act(async () => setState(await enablePush() === 'granted' ? 'on' : 'denied'))}>Turn on notifications</Button>}
        {state === 'on' && <Button type="button" className="m-btn" disabled={busy} onClick={() => void act(async () => { const r = await sendTestPush(); setNote(r.sent > 0 ? 'Test sent.' : 'The push service did not accept the test.') })}>Send test</Button>}
        {state === 'on' && <Button type="button" className="m-btn" disabled={busy} onClick={() => void act(async () => { await disablePush(); setState('off') })}>Turn off</Button>}
      </div>
      {note && <p className="m-card-meta" role="status">{note}</p>}
    </aside>
  )
}
