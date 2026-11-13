// Status glyph of a session (`sessionStatusView`): bell, spinner, error or unread dot; nothing when calm.
import type { StatusTone, StatusView } from './sessionStatus.model'

/** Theme tokens already used for these states (styles.css); inline so the glyph needs no stylesheet. */
const TONE_COLOR: Record<StatusTone, string> = {
  attention: 'var(--state-attention)',
  working: 'var(--state-working)',
  error: 'var(--vscode-errorForeground, var(--state-attention))',
  unread: 'var(--accent)',
  idle: 'inherit',
  muted: 'inherit',
}

/** Renders `view.icon` with the view's label as its accessible name; null for a calm view. */
export function SessionStatusGlyph({ view, className }: { view: StatusView; className?: string }) {
  if (!view.icon) return null
  const spin = view.icon === 'loading' ? ' codicon-modifier-spin' : ''
  return (
    <span className={`session-status session-status--${view.tone}${className ? ` ${className}` : ''}`} style={{ color: TONE_COLOR[view.tone] }} role="img" aria-label={view.label} title={view.label}>
      <span className={`codicon codicon-${view.icon}${spin}`} aria-hidden />
    </span>
  )
}
