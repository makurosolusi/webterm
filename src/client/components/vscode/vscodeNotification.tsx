import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './vscode-overlay.css'

export type VscodeNotificationSeverity = 'info' | 'warning' | 'error'

export interface VscodeNotificationAction {
  label: string
  onClick: () => void
}

export interface VscodeNotificationProps {
  id: string
  severity: VscodeNotificationSeverity
  title: string
  message?: string
  actions?: VscodeNotificationAction[]
  /** Suppresses the automatic 8s dismissal. Warning/error are never auto-dismissed. */
  sticky?: boolean
  onClose: () => void
}

const INFO_TIMEOUT_MS = 8000

function SeverityIcon({ severity }: { severity: VscodeNotificationSeverity }) {
  if (severity === 'error') {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.5" fill="currentColor" />
        <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--vscode-notifications-background, #1f1f1f)" strokeWidth="1.5" />
      </svg>
    )
  }
  if (severity === 'warning') {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <path d="M8 1.5l7 12.5H1z" fill="currentColor" />
        <path d="M8 5.5v4" stroke="var(--vscode-notifications-background, #1f1f1f)" strokeWidth="1.5" />
        <circle cx="8" cy="11.6" r="0.9" fill="var(--vscode-notifications-background, #1f1f1f)" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="currentColor" />
      <path d="M8 7v4" stroke="var(--vscode-notifications-background, #1f1f1f)" strokeWidth="1.6" />
      <circle cx="8" cy="4.7" r="0.95" fill="var(--vscode-notifications-background, #1f1f1f)" />
    </svg>
  )
}

/**
 * VS Code notification toast: bottom-right, 3px above the 22px status bar,
 * max-width 400px, 35px header, 24px actions.
 *
 * `role="status"` for info and `role="alert"` for warning/error. Info dismisses
 * after 8s; warnings and errors stay until the user closes them, and hovering or
 * focusing pauses the info timer.
 */
export function VscodeNotification({
  id,
  severity,
  title,
  message,
  actions,
  sticky = false,
  onClose,
}: VscodeNotificationProps) {
  const [paused, setPaused] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (severity !== 'info' || sticky || paused) return
    const timer = window.setTimeout(() => onCloseRef.current(), INFO_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [severity, sticky, paused])

  const pause = () => setPaused(true)
  const resume = () => setPaused(false)
  const role = severity === 'info' ? 'status' : 'alert'

  return createPortal(
    <div
      id={id}
      role={role}
      aria-atomic="true"
      data-slot="vscode-notification"
      data-severity={severity}
      className="vscode-notification"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <div className="vscode-notification__header" data-slot="vscode-notification-header">
        <span className="vscode-notification__icon" data-slot="vscode-notification-icon" aria-hidden="true">
          <SeverityIcon severity={severity} />
        </span>
        <span className="vscode-notification__title" data-slot="vscode-notification-title">
          {title}
        </span>
        <button
          type="button"
          className="vscode-notification__close"
          data-slot="vscode-notification-close"
          aria-label="Close notification"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {(message || (actions && actions.length > 0)) && (
        <div className="vscode-notification__body" data-slot="vscode-notification-body">
          {message && (
            <p className="vscode-notification__message" data-slot="vscode-notification-message">
              {message}
            </p>
          )}
          {actions && actions.length > 0 && (
            <div className="vscode-notification__actions" data-slot="vscode-notification-actions">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="vscode-notification__action"
                  data-slot="vscode-notification-action"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
