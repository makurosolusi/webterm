// Settings rows for OS notifications (rendered inside the Canvas section). Turning the switch on
// is a user gesture, so that is where the browser permission is requested.
import { useEffect, useState } from 'react'
import type { Workspace } from '../shared/workspace'
import { fetchWorkspaces } from './api'
import { setWorkspaceMuted, useNotifyPrefs, writeNotifyPrefs } from './osNotify.prefs'
import { ToggleField } from './SettingsFields'

function permissionHint(): string {
  if (typeof Notification === 'undefined') return 'This browser does not support desktop notifications; only the sound and tab badge are used.'
  if (Notification.permission === 'denied') return 'Blocked by the browser. Allow notifications for this site in the browser\'s site settings.'
  if (Notification.permission === 'default') return 'Toggle to let the browser ask for permission.'
  return 'Shown when an agent finishes or needs input while you are not looking at it.'
}

export function NotificationRows(): React.JSX.Element {
  const prefs = useNotifyPrefs()
  const [, rerender] = useState(0)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  useEffect(() => {
    fetchWorkspaces().then(setWorkspaces, (err) => console.warn('osNotify: could not list workspaces for mute rows', err))
  }, [])

  const onEnabled = (v: boolean) => {
    writeNotifyPrefs({ enabled: v })
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().then(() => rerender((n) => n + 1))
    }
  }

  return (
    <>
      <ToggleField id="st-osNotify" label="Desktop notifications" value={prefs.enabled}
        hint={permissionHint()} onChange={onEnabled} />
      <ToggleField id="st-osNotifySound" label="Notification sound" value={prefs.sound}
        hint="Short chime when an agent finishes or needs input." onChange={(v) => writeNotifyPrefs({ sound: v })} />
      {workspaces.map((ws) => (
        <ToggleField key={ws.id} id={`st-osNotifyMute-${ws.id}`} label={`Mute notifications: ${ws.name}`}
          value={prefs.muted.includes(ws.id)} onChange={(v) => setWorkspaceMuted(ws.id, v)} />
      ))}
    </>
  )
}
