// Page-lifecycle hooks of the board save (data-209-4), VS Code web `BrowserLifecycleService`
// style: the debounced save is written the moment the page may go away (hidden, pagehide,
// beforeunload) instead of being dropped with the timer, and leaving while a save is pending, in
// flight or failed asks first. The PUT itself rides `keepalive` (see `saveWorkspace`), so a
// flush on unload survives the document. A failed save is retried as soon as the link is back:
// the browser's `online`, or the shared socket entering `connected` from any other phase (first
// connect, reconnect, a re-auth after `auth`).
import { useEffect } from 'react'
import { getConnection, subscribeConnection } from './ws.connection'

export interface SaveLifecycleDeps {
  /** Write the debounced save now. */
  flushSave: () => void
  /** Resend a failed save now. */
  retrySave: () => void
  /** True while any change has not been confirmed by the server. */
  hasUnsaved: () => boolean
}

export function useSaveLifecycle({ flushSave, retrySave, hasUnsaved }: SaveLifecycleDeps): void {
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushSave() }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flushSave()
      if (!hasUnsaved()) return
      e.preventDefault()
      e.returnValue = '' // older Chromium shows the prompt only when returnValue is set
    }
    window.addEventListener('pagehide', flushSave)
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('online', retrySave)
    document.addEventListener('visibilitychange', onVisibility)
    let phase = getConnection().phase
    const offConnection = subscribeConnection((s) => {
      const was = phase
      phase = s.phase
      if (s.phase === 'connected' && was !== 'connected') retrySave()
    })
    return () => {
      window.removeEventListener('pagehide', flushSave)
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('online', retrySave)
      document.removeEventListener('visibilitychange', onVisibility)
      offConnection()
    }
  }, [flushSave, retrySave, hasUnsaved])
}
