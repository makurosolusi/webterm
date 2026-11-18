// Sync control of a split browser node (header): off = a button (the first time it asks once, "Actions you take will repeat in
// every pane"), on = a visible "Sync on" indicator with a Stop button. Keyboard: Enter/Space on the buttons, Escape in the
// indicator stops. State changes are announced (role=status). Needs at least two panes; says why when it does not.
import { useState } from 'react'
import { Link2, Link2Off } from 'lucide-react'
import { ActionButton, useAction } from '@/components/ui/action'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import { SYNC_WARNING, rememberSyncWarned, setSync, syncWarned } from './browserSync'
import type { SyncView } from './browserSync'
import './browserSync.css'

export interface BrowserSyncToggleProps {
  nodeId: string
  sync: SyncView
  /** Panes on screen; sync needs 2 or more. */
  panes: number
}

export function BrowserSyncToggle({ nodeId, sync, panes }: BrowserSyncToggleProps) {
  const [ask, setAsk] = useState<{ x: number; y: number } | null>(null)
  // The server's `sync` message flips the indicator; a refused request shows as a failed action, inline (no toast: it would cover the node).
  const start = useAction(() => setSync(nodeId, true), { label: 'Turn on sync', minBusyMs: 0 })
  const stop = useAction(() => setSync(nodeId, false), { label: 'Stop sync', minBusyMs: 0 })
  const enough = panes >= 2
  return (
    <span className="bsync" data-on={sync.on ? 'true' : 'false'}>
      {sync.on ? (
        <span className="bsync-on" role="group" aria-label="Sync is on" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void stop.run() } }}>
          <Link2 aria-hidden="true" className="bsync-icon" />
          <span className="bsync-pill">Sync on</span>
          <ActionButton action={stop} busyLabel="Stopping" variant="ghost" size="bui" className="bsync-stop" aria-label="Stop sync" aria-keyshortcuts="Escape">Stop</ActionButton>
        </span>
      ) : (
        <IconButton
          label="Sync panes" tooltip={enough ? 'Repeat what you do in one pane in every pane' : 'Split the node into 2 or more panes to sync them'}
          size="icon-bui" aria-pressed={false} aria-haspopup={syncWarned() ? undefined : 'menu'} disabled={!enough} disabledReason="needs 2 or more panes" data-sync-button
          onClick={(e) => {
            if (syncWarned()) { void start.run(); return }
            const r = e.currentTarget.getBoundingClientRect()
            setAsk({ x: r.left, y: r.bottom })
          }}
        >
          <Link2Off aria-hidden="true" />
        </IconButton>
      )}
      <span className="bsync-live" role="status" aria-live="polite">{sync.on ? 'Sync on' : ''}</span>
      {[start, stop].map((a) => (a.result && !a.result.ok ? <span key={a.label} className="bsync-error" role="alert">{a.result.text}</span> : null))}
      {ask && (
        <VscodeMenu
          open anchor={ask} ariaLabel="Turn on sync" onClose={() => setAsk(null)}
          items={[
            { type: 'item', id: 'warning', label: SYNC_WARNING, disabled: true },
            { type: 'separator' },
            { type: 'item', id: 'on', label: 'Turn on sync', onSelect: () => { rememberSyncWarned(); void start.run() } },
            { type: 'item', id: 'cancel', label: 'Cancel', onSelect: () => undefined },
          ]}
        />
      )}
    </span>
  )
}
