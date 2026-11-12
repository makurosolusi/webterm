// Notifications switch for /m: one tap to subscribe (the server holds the VAPID key), a test
// button, and plain instructions when this browser cannot get there (HTTP, iOS outside the app).
import { useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { inboxErrorMessage } from '../inboxApi'
import { browserPushEnv, disablePush, enablePush, pushSupport, sendTestPush, SUPPORT_TEXT, syncPush, type PushSupport } from './mobile.push'

type State = 'checking' | 'off' | 'on' | 'denied'

export function MobilePushCard(props: { support?: PushSupport }): React.JSX.Element {
  const support = props.support ?? pushSupport(browserPushEnv())
  const [state, setState] = useState<State>('checking')
  const [note, setNote] = useState<string | null>(null)
  const failure = (what: string) => (err: unknown) => `${what} failed: ${inboxErrorMessage(err)}`
  const enable = useAction(async () => { const on = await enablePush() === 'granted'; setState(on ? 'on' : 'denied'); return on },
    { label: 'Turn on notifications', success: (on) => (on ? 'Notifications on.' : 'Blocked by the browser.'), failure: failure('Turn on notifications') })
  const test = useAction(sendTestPush,
    { label: 'Send test', success: (r) => (r.sent > 0 ? 'Test sent.' : 'The push service did not accept the test.'), ok: (r) => r.sent > 0, failure: failure('Send test') })
  const disable = useAction(async () => { await disablePush(); setState('off') },
    { label: 'Turn off', success: () => 'Notifications off.', failure: failure('Turn off') })
  const busy = enable.busy || test.busy || disable.busy

  useEffect(() => {
    if (support !== 'ok') return
    if (Notification.permission === 'denied') { setState('denied'); return }
    syncPush().then((on) => setState(on ? 'on' : 'off'), (err: unknown) => { setState('off'); setNote(inboxErrorMessage(err)) })
  }, [support])

  if (support !== 'ok') return <aside className="m-card m-push"><div className="m-card-kind">Notifications</div><p className="m-card-body">{SUPPORT_TEXT[support]}</p></aside>

  return (
    <aside className="m-card m-push">
      <div className="m-card-kind">Notifications</div>
      {state === 'denied' && <p className="m-card-body">Notifications are blocked for this site. Allow them in the browser or system settings, then reload.</p>}
      {state === 'off' && <p className="m-card-body">Get a notification when an agent needs approval or input, and when the morning brief is ready. Nothing is sent while you are looking at that agent on the desktop.</p>}
      {state === 'on' && <p className="m-card-body">On for this device.</p>}
      <div className="m-actions">
        {state === 'off' && <ActionButton type="button" className="m-btn m-primary" disabled={busy} action={enable} busyLabel="Turning on…">Turn on notifications</ActionButton>}
        {state === 'on' && <ActionButton type="button" className="m-btn" disabled={busy} action={test} busyLabel="Sending…">Send test</ActionButton>}
        {state === 'on' && <ActionButton type="button" className="m-btn" disabled={busy} action={disable} busyLabel="Turning off…">Turn off</ActionButton>}
      </div>
      {note && <p className="m-card-meta" role="status">{note}</p>}
      <ActionResult action={enable} />
      <ActionResult action={test} />
      <ActionResult action={disable} />
    </aside>
  )
}
