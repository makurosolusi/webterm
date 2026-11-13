// The three non-data states of a list inside a SettingsGroup card (Rules & secrets, Account, About this
// machine): loading, failed with Retry, and empty with its first action. One look on every page.
import { Button } from '@/components/ui/button'
import './settings-system.css'

export const CARD_STATE_TEXT = { retry: 'Retry' } as const

export function CardLoading({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="status" className="st-state" data-state="loading">
      <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{text}
    </p>
  )
}

/** A failed load: the reason and Retry (re-runs the load). */
export function CardError({ text, onRetry }: { text: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="st-state st-state--error" data-state="error">
      <span className="codicon codicon-error" aria-hidden="true" />
      <span>{text}</span>
      {onRetry ? <Button size="sm" variant="outline" onClick={onRetry}>{CARD_STATE_TEXT.retry}</Button> : null}
    </div>
  )
}

/** Nothing yet: one sentence, then the action that adds the first item. */
export function CardEmpty({ text, children }: { text: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="st-state st-state--empty" data-state="empty">
      <span>{text}</span>
      {children}
    </div>
  )
}
