import type { HTMLAttributes } from 'react'
import './vscode-controls.css'

export type VscodeCardVariant = 'default' | 'tile'

export interface VscodeCardProps extends HTMLAttributes<HTMLDivElement> {
  /** `tile` is the Welcome/Kanban surface; it lifts its border on hover. */
  variant?: VscodeCardVariant
}

/**
 * VS Code editor-widget surface: 1px border, 4px radius, no shadow.
 *
 * Header, body and footer are optional sections. When all three are present the
 * card still keeps the 12px body padding from the spec; header and footer bleed to
 * the border so they read as a real section, not an inset box.
 */
export function VscodeCard({ variant = 'default', className, children, ...props }: VscodeCardProps) {
  return (
    <div
      data-slot="vscode-card"
      data-variant={variant}
      className={['vscode-card', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}

export function VscodeCardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="vscode-card-header"
      className={['vscode-card__header', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}

export function VscodeCardTitle({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="vscode-card-title"
      className={['vscode-card__title', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}

export function VscodeCardBody({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="vscode-card-body"
      className={['vscode-card__body', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}

export function VscodeCardFooter({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="vscode-card-footer"
      className={['vscode-card__footer', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}
