// Sync control of a split browser node (header): off = a button (the first time it asks once, "Actions you take will repeat in
// every pane"), on = a visible "Sync on" indicator with a Stop button. Keyboard: Enter/Space on the buttons, Escape in the
// indicator stops. State changes are announced (role=status). Needs at least two panes; says why when it does not.
import { useState } from 'react'
import { Link2, Link2Off } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import { BrowserApiError } from '../browser.api'
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
  const [error, setError] = useState('')
  const change = async (on: boolean) => {
    setError('')
    try {
      await setSync(nodeId, on) // the server's `sync` message flips the indicator; no optimistic state to undo
    } catch (err) {
      setError(err instanceof BrowserApiError ? `Could not ${on ? 'turn on' : 'stop'} sync (${err.code})` : `Could not ${on ? 'turn on' : 'stop'} sync`)
    }
  }
  const enough = panes >= 2
  return (
    <span className="bsync" data-on={sync.on ? 'true' : 'false'}>
      {sync.on ? (
        <span className="bsync-on" role="group" aria-label="Sync is on" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void change(false) } }}>
          <Link2 aria-hidden="true" className="bsync-icon" />
          <span className="bsync-pill">Sync on</span>
          <button type="button" className="bsync-stop" aria-label="Stop sync" title="Stop sync (Esc)" onClick={() => { void change(false) }}>Stop</button>
        </span>
      ) : (
        <IconButton
          label="Sync panes" tooltip={enough ? 'Repeat what you do in one pane in every pane' : 'Split the node into 2 or more panes to sync them'}
          size="icon-xs" aria-pressed={false} aria-haspopup={syncWarned() ? undefined : 'menu'} disabled={!enough} disabledReason="needs 2 or more panes" data-sync-button
          onClick={(e) => {
            if (syncWarned()) { void change(true); return }
            const r = e.currentTarget.getBoundingClientRect()
            setAsk({ x: r.left, y: r.bottom })
          }}
        >
          <Link2Off aria-hidden="true" />
        </IconButton>
      )}
      <span className="bsync-live" role="status" aria-live="polite">{sync.on ? 'Sync on' : ''}</span>
      {error && <span className="bsync-error" role="alert">{error}</span>}
      {ask && (
        <VscodeMenu
          open anchor={ask} ariaLabel="Turn on sync" onClose={() => setAsk(null)}
          items={[
            { type: 'item', id: 'warning', label: SYNC_WARNING, disabled: true },
            { type: 'separator' },
            { type: 'item', id: 'on', label: 'Turn on sync', onSelect: () => { rememberSyncWarned(); void change(true) } },
            { type: 'item', id: 'cancel', label: 'Cancel', onSelect: () => undefined },
          ]}
        />
      )}
    </span>
  )
}
