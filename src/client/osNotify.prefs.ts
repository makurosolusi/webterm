// Per-browser preferences for OS notifications. localStorage, not server `Settings`: notification
// permission and audio are properties of THIS browser, so a second device must not inherit "on"
// for a permission it never granted. Defaults are ON (zero-config): a fresh tab notifies without
// the user hunting for a switch.
import { useSyncExternalStore } from 'react'

export interface NotifyPrefs {
  /** Desktop notifications (Web Notifications API). */
  enabled: boolean
  /** Short sound alongside the notification. */
  sound: boolean
  /** Workspace ids whose agents never notify (Orca: muted workspaces get no banner/sound/push). */
  muted: string[]
}

const KEY = 'webterm.osNotify'
const DEFAULTS: NotifyPrefs = { enabled: true, sound: true, muted: [] }
const listeners = new Set<() => void>()
let cache: NotifyPrefs | null = null

export function readNotifyPrefs(): NotifyPrefs {
  if (cache) return cache
  let stored: Partial<NotifyPrefs> = {}
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    if (raw) stored = JSON.parse(raw) as Partial<NotifyPrefs>
  } catch (err) {
    // Corrupt JSON must not disable notifications: fall back to defaults, but say so.
    console.warn('osNotify: ignoring unreadable prefs in localStorage', err)
  }
  cache = {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
    sound: typeof stored.sound === 'boolean' ? stored.sound : DEFAULTS.sound,
    muted: Array.isArray(stored.muted) ? stored.muted.filter((x) => typeof x === 'string') : [],
  }
  return cache
}

export function writeNotifyPrefs(patch: Partial<NotifyPrefs>): void {
  cache = { ...readNotifyPrefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch (err) {
    // Private mode / quota: the choice still holds for this tab.
    console.warn('osNotify: could not persist prefs', err)
  }
  for (const l of listeners) l()
}

export function setWorkspaceMuted(workspaceId: string, muted: boolean): void {
  const rest = readNotifyPrefs().muted.filter((id) => id !== workspaceId)
  writeNotifyPrefs({ muted: muted ? [...rest, workspaceId] : rest })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** React view of the prefs; re-renders on every write. */
export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(subscribe, readNotifyPrefs)
}
