import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './vscode-notification.css'

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
  /** 0-100 renders a determinate 2px progress bar, 'infinite' an indeterminate one. */
  progress?: number | 'infinite'
  onClose: () => void
}

const INFO_TIMEOUT_MS = 8000
const SEVERITY_ICON: Record<VscodeNotificationSeverity, string> = {
  info: 'codicon-info',
  warning: 'codicon-warning',
  error: 'codicon-error',
}

const InStackContext = createContext(false)

/** Bottom-right toast column (right 3px, above the status bar); newest toast sits lowest. */
export function VscodeNotificationStack({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="vscode-notification-stack" data-slot="vscode-notification-stack">
      <InStackContext.Provider value>{children}</InStackContext.Provider>
    </div>,
    document.body,
  )
}

/**
 * VS Code notification toast: max 450px, codicon severity icon, hover/focus-revealed
 * close, button actions, optional 2px progress bar.
 *
 * `role="status"` for info and `role="alert"` for warning/error. Info dismisses
 * after 8s; warnings and errors stay until the user closes them, and hovering or
 * focusing pauses the info timer. Rendered outside a `VscodeNotificationStack` it
 * wraps itself in one.
 */
export function VscodeNotification(props: VscodeNotificationProps) {
  const inStack = useContext(InStackContext)
  const toast = <VscodeNotificationItem {...props} />
  return inStack ? toast : <VscodeNotificationStack>{toast}</VscodeNotificationStack>
}

function VscodeNotificationItem({
  id,
  severity,
  title,
  message,
  actions,
  sticky = false,
  progress,
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
  const hasActions = actions !== undefined && actions.length > 0

  return (
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
      <div className="vscode-notification__main" data-slot="vscode-notification-header">
        <span
          className={`vscode-notification__icon codicon ${SEVERITY_ICON[severity]}`}
          data-slot="vscode-notification-icon"
          aria-hidden="true"
        />
        <div className="vscode-notification__text">
          <span className="vscode-notification__title" data-slot="vscode-notification-title">
            {title}
          </span>
          {message && (
            <p className="vscode-notification__message" data-slot="vscode-notification-message">
              {message}
            </p>
          )}
        </div>
        <button
          type="button"
          className="vscode-notification__close"
          data-slot="vscode-notification-close"
          aria-label="Close notification"
          onClick={onClose}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      {hasActions && (
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
      {progress !== undefined && (
        <div
          className="vscode-notification__progress"
          data-slot="vscode-notification-progress"
          data-mode={progress === 'infinite' ? 'infinite' : 'discrete'}
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress === 'infinite' ? undefined : Math.round(progress)}
        >
          <span
            className="vscode-notification__progress-bit"
            style={progress === 'infinite' ? undefined : { width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
    </div>
  )
}
