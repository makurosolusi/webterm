// Settings › Notifications: desktop notifications and their sound. The switch shows the REAL state:
// on only while this browser has granted permission, so a blocked site never reads "on". Turning it on
// is the user gesture that asks the browser; a refusal keeps it off and says how to allow it.
// "Saved on this browser" shows only once the choice is really stored (never after a refusal).
// Per-workspace mute lives in the workspace menu (WorkspaceBar), next to the workspace it mutes.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Lock } from '@/components/ui/disabled-reason'
import { Switch } from '@/components/ui/switch'
import { NOTIFY_DEFAULTS, useNotifyPrefs, writeNotifyPrefs } from './osNotify.prefs'
import { SettingsGroup } from './SettingsControls'
import { Field, lockReasonId, ToggleField } from './SettingsFields'
import { useLocalFieldSave } from './settingsSave'

export const NOTIFY_TEXT = {
  desktop: 'Desktop notifications',
  desktopHint: 'Shown when an agent finishes or needs input while you are not looking at it.',
  sound: 'Notification sound',
  soundHint: 'Short chime when an agent finishes or needs input.',
  unsupported: 'This browser does not support desktop notifications; only the sound and tab badge are used.',
  blocked: 'Blocked by the browser. To allow: click the icon left of the address bar, set Notifications to Allow, then come back to this tab.',
  refused: 'The browser did not allow notifications, so they stay off.',
  askAgain: 'Ask again',
  checkAgain: 'Check again',
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

/** Desktop notifications switch state: on only while granted; turning it on asks the browser first.
 * Shared by Settings › Notifications and the setup wizard so both read the real permission. */
export function useDesktopNotify(): { on: boolean; lock: Lock | undefined; refused: boolean; set(v: boolean): Promise<boolean> } {
  const prefs = useNotifyPrefs()
  const [permission, refresh] = useNotifyPermission()
  const [refused, setRefused] = useState(false)
  const lock: Lock | undefined = permission === 'unsupported' ? { reason: NOTIFY_TEXT.unsupported }
    : permission === 'denied' ? { reason: NOTIFY_TEXT.blocked, fix: { label: NOTIFY_TEXT.checkAgain, run: refresh } } : undefined
  /** Resolves true when `v` was stored as asked; false when the browser refused (stored off, or nothing). */
  const set = (v: boolean): Promise<boolean> => {
    setRefused(false)
    if (!v || permission === 'granted') { writeNotifyPrefs({ enabled: v }); return Promise.resolve(true) }
    // Saved "on" only once the browser grants it.
    return Notification.requestPermission().then((answer) => {
      writeNotifyPrefs({ enabled: answer === 'granted' })
      setRefused(answer !== 'granted')
      refresh()
      return answer === 'granted'
    }, (err: unknown) => {
      console.warn('osNotify: asking for notification permission failed', err)
      setRefused(true)
      return false
    })
  }
  return { on: permission === 'granted' && prefs.enabled, lock, refused: refused && !lock, set }
}

const DESKTOP_ID = 'st-osNotify'

/** Notifications section body. */
export function NotificationsSection(): React.JSX.Element {
  const prefs = useNotifyPrefs()
  const { on, lock, refused, set: setDesktop } = useDesktopNotify()
  const [saved, markSaved] = useLocalFieldSave()
  const change = (v: boolean): void => { void setDesktop(v).then((ok) => { if (ok) markSaved() }) }

  return (
    <div data-testid="notifications-section">
      <SettingsGroup>
        <Field label={NOTIFY_TEXT.desktop} htmlFor={DESKTOP_ID} hint={NOTIFY_TEXT.desktopHint} lock={lock} save={saved}
          modified={!lock && prefs.enabled !== NOTIFY_DEFAULTS.enabled} onReset={() => change(NOTIFY_DEFAULTS.enabled)}>
          <Switch id={DESKTOP_ID} checked={on} disabled={lock !== undefined} aria-describedby={lock ? lockReasonId(DESKTOP_ID) : undefined}
            onCheckedChange={change} />
        </Field>
        {refused ? (
          // The real state, with the one thing that can change it: a dismissed prompt can be asked again.
          <p role="alert" className="st-hint st-notify-refused">
            {NOTIFY_TEXT.refused}{' '}
            <Button type="button" size="xs" variant="link" className="px-0" onClick={() => change(true)}>{NOTIFY_TEXT.askAgain}</Button>
          </p>
        ) : null}
        <ToggleField id="st-osNotifySound" label={NOTIFY_TEXT.sound} value={prefs.sound} hint={NOTIFY_TEXT.soundHint} savedLocally
          modified={prefs.sound !== NOTIFY_DEFAULTS.sound} onReset={() => writeNotifyPrefs({ sound: NOTIFY_DEFAULTS.sound })}
          onChange={(v) => writeNotifyPrefs({ sound: v })} />
      </SettingsGroup>
    </div>
  )
}
