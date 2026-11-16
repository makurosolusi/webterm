// The turn status where the answer grows: a fixed-height row at the end of the thread (never in a header),
// a visually hidden live region for screen readers, and the sticky error surface above the composer.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { announceState, announcement, type AnnounceState, type TurnPhaseInfo } from './chatTurnPhase'
import './chatInlineStatus.css'

function rowText(info: TurnPhaseInfo): string {
  switch (info.phase) {
    case 'waiting': return 'Thinking…'
    case 'streaming': return 'Responding…'
    case 'tool': return `Running: ${info.tool ?? 'a tool'}…`
    case 'approval': return 'Waiting for approval…'
    case 'reconnecting': return 'Reconnecting…'
    default: return ''
  }
}

/** End-of-thread status row. Always mounted at a fixed height, so a phase change never shifts the thread. */
export function ChatInlineStatus({ info }: { info: TurnPhaseInfo }) {
  const text = rowText(info)
  // Icon + text, not color alone; the sr-only region owns the announcement, so the row is hidden from it.
  const icon = info.phase === 'reconnecting' ? 'codicon-debug-disconnect' : info.phase === 'approval' ? 'codicon-shield' : info.phase === 'tool' ? 'codicon-tools' : null
  return (
    <div className="chat-inline-status" data-phase={info.phase} aria-hidden="true">
      {text !== '' && (
        <>
          {icon
            ? <span className={`codicon ${icon}`} />
            : <span className="chat-inline-status__dots"><i /><i /><i /></span>}
          <span className="chat-inline-status__text">{text}</span>
        </>
      )}
    </div>
  )
}

/** Always-mounted polite live region: one sentence per coarse change (start, finish, fail, reconnect), never per token. */
export function TurnLiveRegion({ info, failed }: { info: TurnPhaseInfo; failed: boolean }) {
  const next = announceState(info.phase, failed)
  const prev = useRef<AnnounceState>('idle')
  const [text, setText] = useState('')
  useEffect(() => {
    const said = announcement(prev.current, next)
    prev.current = next
    if (said !== null) setText(said)
    else if (next === 'idle') setText('')
  }, [next])
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="turn-live-region">{text}</div>
}

export interface ChatErrorDockProps {
  message: string
  onDismiss: () => void
  /** Offered when the failure can be tried again. */
  onRetry?: (() => void) | undefined
}

/** Sticky failure surface between the thread and the composer: the reason, Retry when possible, Dismiss. */
export function ChatErrorDock({ message, onDismiss, onRetry }: ChatErrorDockProps) {
  return (
    <div className="chat-error chat-error--dock" role="alert">
      <span className="codicon codicon-error" aria-hidden="true" />
      <span>{message}</span>
      {onRetry && <Button variant="secondary" size="xs" onClick={onRetry}>Retry</Button>}
      <IconButton label="Dismiss error" size="icon-xs" className="chat-error__dismiss" onClick={onDismiss}>
        <span className="codicon codicon-close" aria-hidden="true" />
      </IconButton>
    </div>
  )
}
