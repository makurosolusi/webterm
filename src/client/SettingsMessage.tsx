// A page-level notice inside Settings (VS Code / GitHub flash style): severity icon, one sentence and an
// optional action such as Retry. For loading and load-failure states that belong to a whole page or card;
// a single row's save state stays on the row (FieldSaveStatus).
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import './settings-agent-pages.css'

const ICON = { info: 'codicon-info', warning: 'codicon-warning', error: 'codicon-error', loading: 'codicon-loading codicon-modifier-spin' } as const

/** One notice line; `error` is announced as an alert, `loading` as a status. */
export function SettingsMessage({ kind, action, children }: {
  kind: keyof typeof ICON
  action?: { label: string; run(): void }
  children: ReactNode
}): React.JSX.Element {
  const role = kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : undefined
  return (
    <div className={`st-message st-message--${kind}`} role={role} data-slot="settings-message">
      <span className={`codicon ${ICON[kind]}`} aria-hidden="true" />
      <span className="st-message-text">{children}</span>
      {action ? <Button size="xs" variant="secondary" onClick={action.run}>{action.label}</Button> : null}
    </div>
  )
}
