import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { IconTooltip } from '@/components/ui/icon-button'
import './vscode-overlay.css'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Open-dialog stack. Nested dialogs are separate portals, so React still bubbles
 * their key events through the wrapper tree; only the topmost entry may consume
 * Escape. Without this an inner Escape would also close its parent.
 */
const dialogStack: symbol[] = []

function pushDialog(id: symbol): void {
  dialogStack.push(id)
}

function popDialog(id: symbol): void {
  const index = dialogStack.lastIndexOf(id)
  if (index >= 0) dialogStack.splice(index, 1)
}

function isTopDialog(id: symbol): boolean {
  return dialogStack[dialogStack.length - 1] === id
}

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

export interface VscodeDialogProps {
  open: boolean
  /** Called with `false` on backdrop click, the close button, or Escape. */
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** Default 480, the VS Code modal proportion. */
  width?: number
  /** Default true. Escape and backdrop clicks are ignored when false. */
  dismissible?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  children?: ReactNode
  footer?: ReactNode
  className?: string
}

/**
 * VS Code-style modal: portal to body, 480px default width, 8px padding with a
 * 12px content inset, 14px semibold title, 13px body, `x` close button, Esc.
 * Footer actions are right-aligned; order them with `arrangeDialogButtons`.
 *
 * Focus is trapped inside the dialog and restored to the trigger on close. The
 * document body is deliberately not scroll-locked: the shell owns overflow, and
 * locking body would fire an xterm resize on every dialog.
 */
export function VscodeDialog({
  open,
  onOpenChange,
  title,
  description,
  width = 480,
  dismissible = true,
  initialFocus,
  children,
  footer,
  className,
}: VscodeDialogProps) {
  const dialogId = useRef(Symbol('vscode-dialog'))
  const rootRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  // Keep the effect dependent only on `open`: parents commonly pass inline
  // callbacks, and re-running the focus setup on every render would steal focus.
  const onOpenChangeRef = useRef(onOpenChange)
  const dismissibleRef = useRef(dismissible)
  const initialFocusRef = useRef(initialFocus)
  onOpenChangeRef.current = onOpenChange
  dismissibleRef.current = dismissible
  initialFocusRef.current = initialFocus

  useEffect(() => {
    if (!open) return
    const id = dialogId.current
    const root = rootRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    pushDialog(id)
    const target = initialFocusRef.current?.current ?? focusableIn(root)[0] ?? root
    target?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dismissibleRef.current || !isTopDialog(id)) return
      event.preventDefault()
      event.stopPropagation()
      onOpenChangeRef.current(false)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      popDialog(id)
      // Only restore when the trigger is still in the document; a dialog that
      // unmounts together with its screen must not focus a detached node.
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const root = rootRef.current
    const nodes = focusableIn(root)
    if (!root) return
    if (nodes.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const close = () => {
    if (dismissible) onOpenChange(false)
  }

  return createPortal(
    <div
      className="vscode-dialog-backdrop"
      data-slot="vscode-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-slot="vscode-dialog"
        className={['vscode-dialog', className].filter(Boolean).join(' ')}
        style={{ width }}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <div className="vscode-dialog__header" data-slot="vscode-dialog-header">
          <h2 id={titleId} className="vscode-dialog__title" data-slot="vscode-dialog-title">
            {title}
          </h2>
          {dismissible && (
            <IconTooltip label="Close dialog" shortcut="Esc">
              <button
                type="button"
                className="vscode-dialog__close"
                data-slot="vscode-dialog-close"
                aria-label="Close dialog"
                onClick={() => onOpenChange(false)}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </IconTooltip>
          )}
        </div>
        <div className="vscode-dialog__body" data-slot="vscode-dialog-body">
          {description && (
            <p id={descriptionId} className="vscode-dialog__description" data-slot="vscode-dialog-description">
              {description}
            </p>
          )}
          {children}
        </div>
        {footer && (
          <div className="vscode-dialog__footer" data-slot="vscode-dialog-footer">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
