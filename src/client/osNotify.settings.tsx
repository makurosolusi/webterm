// Settings › Notifications: desktop notifications and their sound. The switch shows the REAL state:
// on only while this browser has granted permission, so a blocked site never reads "on". Turning it on
// is the user gesture that asks the browser; a refusal keeps it off and says how to allow it.
// Per-workspace mute lives in the workspace menu (WorkspaceBar), next to the workspace it mutes.
import { useEffect, useState } from 'react'
import type { Lock } from '@/components/ui/disabled-reason'
import { useNotifyPrefs, writeNotifyPrefs } from './osNotify.prefs'
import { ToggleField } from './SettingsFields'

export const NOTIFY_TEXT = {
  desktop: 'Desktop notifications',
  desktopHint: 'Shown when an agent finishes or needs input while you are not looking at it.',
  sound: 'Notification sound',
  soundHint: 'Short chime when an agent finishes or needs input.',
  unsupported: 'This browser does not support desktop notifications; only the sound and tab badge are used.',
  blocked: 'Blocked by the browser. To allow: click the icon left of the address bar, set Notifications to Allow, then come back to this tab.',
  refused: 'The browser did not allow notifications, so they stay off.',
} as const

type Permission = NotificationPermission | 'unsupported'
const readPermission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

/** The browser's notification permission, kept current (permission changes, returning to the tab). */
export function useNotifyPermission(): [Permission, () => void] {
  const [permission, setPermission] = useState(readPermission)
  useEffect(() => {
    const sync = (): void => setPermission(readPermission())
    window.addEventListener('focus', sync)
    let status: PermissionStatus | null = null
    navigator.permissions?.query({ name: 'notifications' as PermissionName }).then((s) => {
      status = s
      s.addEventListener('change', sync)
    }, (err: unknown) => console.warn('osNotify: permission state cannot be watched; it refreshes on tab focus', err))
    return () => {
      window.removeEventListener('focus', sync)
      status?.removeEventListener('change', sync)
    }
  }, [])
  return [permission, () => setPermission(readPermission())]
}

/** Notifications section body. */
export function NotificationsSection(): React.JSX.Element {
  const prefs = useNotifyPrefs()
  const [permission, refresh] = useNotifyPermission()
  const [refused, setRefused] = useState(false)

  const lock: Lock | undefined = permission === 'unsupported' ? { reason: NOTIFY_TEXT.unsupported }
    : permission === 'denied' ? { reason: NOTIFY_TEXT.blocked } : undefined
  const on = permission === 'granted' && prefs.enabled

  const onDesktop = (v: boolean): void => {
    setRefused(false)
    if (!v || permission === 'granted') { writeNotifyPrefs({ enabled: v }); return }
    // Saved "on" only once the browser grants it.
    Notification.requestPermission().then((answer) => {
      writeNotifyPrefs({ enabled: answer === 'granted' })
      setRefused(answer !== 'granted')
      refresh()
    }, (err: unknown) => {
      console.warn('osNotify: asking for notification permission failed', err)
      setRefused(true)
    })
  }

  return (
    <div data-testid="notifications-section">
      <ToggleField id="st-osNotify" label={NOTIFY_TEXT.desktop} value={on} hint={NOTIFY_TEXT.desktopHint} lock={lock} onChange={onDesktop} />
      {refused && !lock ? <p role="alert" className="st-hint">{NOTIFY_TEXT.refused}</p> : null}
      <ToggleField id="st-osNotifySound" label={NOTIFY_TEXT.sound} value={prefs.sound}
        hint={NOTIFY_TEXT.soundHint} onChange={(v) => writeNotifyPrefs({ sound: v })} />
    </div>
  )
}
