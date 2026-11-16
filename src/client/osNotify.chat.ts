// OS banner when Central replies in a conversation the user is not looking at. Same gates as the agent
// banner (`./osNotify`): notification prefs on, permission granted, and only while the window is not focused
// (an in-app notice covers the focused case).
import { readNotifyPrefs } from './osNotify.prefs'

const TAG = 'webterm-chat'

/** `labels` = conversations that got a reply; `onOpen` runs when the banner is clicked. */
export function noteChatReply(labels: string[], onOpen: () => void): void {
  if (typeof window === 'undefined' || typeof Notification === 'undefined' || labels.length === 0) return
  if (!readNotifyPrefs().enabled || Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  const title = labels.length === 1 ? `Central replied in ${labels[0]}` : `Central replied in ${labels.length} conversations`
  const n = new Notification(title, { body: labels.length === 1 ? '' : labels.join('\n'), tag: TAG })
  n.onclick = () => { window.focus(); n.close(); onOpen() }
}
