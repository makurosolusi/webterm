// Server-side limit of what a preset-locked agent chat node (today `skill-author`) may do with a browser: read
// public pages only. Enforced in the control handler from the node's STORED preset, so it holds even if the
// PreToolUse hook (agentChat.toolLock) were bypassed.
import type { ControlResult } from '../control/controlTypes'
import { isPublicWebUrl } from './browser.publicUrl'

/** Whitelist (not blacklist) of browser verbs a locked node may call; `snapshot` is the page reader. */
export const PRESET_BROWSER_VERBS: ReadonlySet<string> = new Set(['open', 'navigate', 'snapshot'])

const deny = (error: string, message: string): ControlResult => ({ status: 403, body: { error, message } })

/** `null` = allowed; else the 403 result. Only called for a requester whose stored preset is set. */
export function presetBrowserDenial(verb: string, wanted: string | undefined, url: unknown, profile?: unknown, tab?: unknown): ControlResult | null {
  if (!PRESET_BROWSER_VERBS.has(verb)) return deny('verb_not_allowed_for_preset', 'This agent may only open, navigate to and read public web pages.')
  if (wanted !== undefined) return deny('verb_not_allowed_for_preset', 'This agent may only use the browser it opened itself; do not pass --node.')
  // A profile means somebody's logins: a locked read-only agent browses signed out, on the board's Default, never on an account.
  if (profile !== undefined) return deny('profile_not_allowed_for_preset', 'This agent may not choose a browser profile; it browses with the default one.')
  if (tab !== undefined) return deny('verb_not_allowed_for_preset', 'This agent has one page only and may not choose a tab.')
  if (url !== undefined && !isPublicWebUrl(url)) return deny('url_not_public', 'Only public http(s) web pages may be read: no localhost, private addresses, credentials in the URL, or other schemes.')
  return null
}
