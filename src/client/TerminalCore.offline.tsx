import { useEffect, useState, useSyncExternalStore } from 'react'
import { getConnection, subscribeConnection } from './ws.connection'
import { reconnectNow } from './ws'
import { Button } from '@/components/ui/button'

const COUNTDOWN_TICK_MS = 1000

/**
 * Banner over a terminal while the shared socket is down (pty-207-5). VS Code marks a terminal
 * whose backend went away instead of letting keystrokes vanish silently; typing is paused (ws.ts
 * drops input while offline, it is never replayed later into whatever the shell runs by then).
 */
export function TerminalOffline() {
  const conn = useSyncExternalStore(subscribeConnection, getConnection)
  const [now, setNow] = useState(() => Date.now())
  const offline = conn.phase === 'reconnecting'
  useEffect(() => {
    if (!offline) return
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => clearInterval(tick)
  }, [offline, conn.retryAt])
  if (!offline) return null
  const secs = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : 0
  return (
    <div
      role="status"
      className="nodrag absolute top-2 right-2 left-2 z-10 flex items-center gap-2 rounded px-2 py-1 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)"
    >
      <span className="codicon codicon-warning text-amber-600" aria-hidden />
      <span className="flex-1">
        Connection to the webterm server lost. {secs > 0 ? `Reconnecting in ${secs}s…` : 'Reconnecting…'} Typing is paused.
      </span>
      <Button size="xs" variant="secondary" onClick={reconnectNow}>
        Retry now
      </Button>
    </div>
  )
}
