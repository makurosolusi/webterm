// The one app-wide connection surface (VS Code's "reconnecting" notice, Slack's offline banner):
// hidden while connected, otherwise a small strip under the title bar. Terminals only show a slim
// "input paused" overlay (TerminalCore.offline.tsx); countdown and Retry live here, once.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { retryNow } from './ws.connection'
import { useConnection } from './useConnection'

/** Boot grace: the first connect is usually instant, so "Connecting…" waits this long. */
export const CONNECTING_GRACE_MS = 1500
/** How long the "server restarted" notice stays before it dismisses itself. */
export const RESTART_NOTICE_MS = 6000
const TICK_MS = 1000

export const CONNECTION_TEXT = {
  connecting: 'Connecting…',
  reconnecting: (secs: number) => (secs > 0 ? `Reconnecting… retrying in ${secs}s` : 'Reconnecting…'),
  retry: 'Retry now',
  offline: "You're offline. Changes are kept and will sync when you're back.",
  restarted: 'webterm restarted — sessions were relaunched',
  dismiss: 'Dismiss',
  newVersion: 'A new version is available',
  reload: 'Reload',
} as const

/** Module-level so the default stays one stable function. */
const reloadPage = (): void => location.reload()

export interface ConnectionStatusProps {
  /** The server refused our credential: App swaps the board for SignInScreen. */
  onAuthRequired: () => void
  /** Reload the page for a new build; tests replace it. */
  reload?: () => void
}

/** Seconds until `at`, ticking once a second while `active`. */
function useCountdown(at: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(tick)
  }, [active, at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0
}

/** True once `on` has held for `ms` without interruption. */
function useAfter(on: boolean, ms: number): boolean {
  const [due, setDue] = useState(false)
  useEffect(() => {
    setDue(false)
    if (!on) return
    const t = setTimeout(() => setDue(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && due
}

/** The restart notice: shown once per `serverRestartedAt` after the socket is back, then auto-hidden. */
function useRestartNotice(restartedAt: number | undefined, connected: boolean): [boolean, () => void] {
  const [shown, setShown] = useState<number | null>(null)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!connected || !restartedAt || seen.current === restartedAt) return
    seen.current = restartedAt
    setShown(restartedAt)
    const t = setTimeout(() => setShown(null), RESTART_NOTICE_MS)
    return () => clearTimeout(t)
  }, [restartedAt, connected])
  return [shown !== null, () => setShown(null)]
}

/** App-wide connection status strip; renders nothing while all is well. */
export default function ConnectionStatus({ onAuthRequired, reload = reloadPage }: ConnectionStatusProps) {
  const conn = useConnection()
  const { phase } = conn
  const secs = useCountdown(conn.retryAt, phase === 'reconnecting')
  const slowBoot = useAfter(phase === 'connecting', CONNECTING_GRACE_MS)
  const [restarted, dismissRestart] = useRestartNotice(conn.serverRestartedAt, phase === 'connected')

  useEffect(() => { if (phase === 'auth') onAuthRequired() }, [phase, onAuthRequired])

  const line =
    phase === 'reconnecting' ? (
      <Row icon="sync" text={CONNECTION_TEXT.reconnecting(secs)}>
        <Button size="xs" variant="secondary" onClick={retryNow}>{CONNECTION_TEXT.retry}</Button>
      </Row>
    ) : phase === 'offline' ? (
      <Row icon="debug-disconnect" text={CONNECTION_TEXT.offline} />
    ) : slowBoot ? (
      <Row icon="loading" text={CONNECTION_TEXT.connecting} />
    ) : null

  return (
    // Always mounted: a live region must exist before its text changes or screen readers miss it.
    <div role="status" aria-live="polite" className="connection-status pointer-events-none fixed left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1 top-[calc(var(--tabbar-h,36px)+8px)]">
      {line}
      {restarted && (
        <Row icon="info" text={CONNECTION_TEXT.restarted}>
          <IconButton label={CONNECTION_TEXT.dismiss} size="icon-xs" onClick={dismissRestart}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </IconButton>
        </Row>
      )}
      {conn.buildChanged && (
        <Row icon="cloud-download" text={CONNECTION_TEXT.newVersion}>
          <Button size="xs" onClick={reload}>{CONNECTION_TEXT.reload}</Button>
        </Row>
      )}
    </div>
  )
}

/** One pill of the strip: icon, message, optional action. */
function Row({ icon, text, children }: { icon: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded px-3 py-1 text-xs shadow bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)">
      <span className={`codicon codicon-${icon}${icon === 'loading' ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />
      <span>{text}</span>
      {children}
    </div>
  )
}
