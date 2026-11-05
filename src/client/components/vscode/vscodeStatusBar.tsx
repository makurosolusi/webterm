import type { ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import './vscode-shell.css'

/** Item tones mirror the `statusBarItem.*` color keys (remote, prominent, warning, error) and debugging bar. */
export type VscodeStatusTone = 'default' | 'remote' | 'prominent' | 'debugging' | 'warning' | 'error'

export interface VscodeStatusItem {
  id: string
  label: string
  icon?: ReactNode
  tooltip?: string
  /** When present the item renders as a button; otherwise it is static text. */
  onClick?: () => void
  tone?: VscodeStatusTone
  ariaLabel?: string
  /** ⌘K registry command whose keybinding the tooltip shows. */
  commandId?: string
  /** Renders a disabled button whose tooltip appends `disabledReason`. */
  disabled?: boolean
  disabledReason?: string
}

export interface VscodeStatusBarProps {
  left: VscodeStatusItem[]
  right?: VscodeStatusItem[]
  className?: string
  ariaLabel?: string
  /**
   * Announced through a polite live region. Use for agent summaries (`3 working`)
   * and never for values that change on a timer.
   */
  liveText?: string
}

function StatusItem({ item }: { item: VscodeStatusItem }) {
  const content = (
    <>
      {item.icon ? (
        <span className="vscode-status-bar__icon" data-slot="vscode-status-bar-icon" aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <span className="vscode-status-bar__label">{item.label}</span>
    </>
  )
  const className = 'vscode-status-bar__item'

  const element = item.onClick || item.disabled ? (
    <button
      type="button"
      data-slot="vscode-status-bar-item"
      data-tone={item.tone ?? 'default'}
      className={className}
      aria-label={item.ariaLabel ?? item.tooltip}
      disabled={item.disabled}
      onClick={item.onClick}
    >
      {content}
    </button>
  ) : (
    <span data-slot="vscode-status-bar-item" data-tone={item.tone ?? 'default'} className={className}>
      {content}
    </span>
  )

  if (!item.tooltip) return element
  return (
    <IconTooltip label={item.tooltip} commandId={item.commandId} side="top" disabled={item.disabled} disabledReason={item.disabledReason}>
      {element}
    </IconTooltip>
  )
}

/**
 * VS Code status bar: 22px tall, 12px type, items padded `0 5px`, static items are
 * plain text and only items with `onClick` become buttons.
 *
 * Changes to agent state belong in `liveText`, which lives in a polite live region;
 * the rest of the bar is not announced because timers and connection ticks would
 * otherwise flood a screen reader.
 */
export function VscodeStatusBar({
  left,
  right = [],
  className,
  ariaLabel = 'Status bar',
  liveText,
}: VscodeStatusBarProps) {
  return (
    <footer className={['vscode-status-bar', className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
      <div className="vscode-status-bar__group" data-slot="vscode-status-bar-left">
        {left.map((item) => (
          <StatusItem key={item.id} item={item} />
        ))}
      </div>
      <div className="vscode-status-bar__group" data-slot="vscode-status-bar-right">
        {right.map((item) => (
          <StatusItem key={item.id} item={item} />
        ))}
      </div>
      <span
        className="vscode-status-bar__live"
        data-slot="vscode-status-bar-live"
        role="status"
        aria-live="polite"
      >
        {liveText}
      </span>
    </footer>
  )
}
