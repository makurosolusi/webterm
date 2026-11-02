import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './vscode-overlay.css'

export type VscodeOverlayPlacement = 'top' | 'bottom' | 'left' | 'right'

const VIEWPORT_MARGIN = 8
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function anchorRect(anchor: DOMRect | HTMLElement): DOMRect {
  if (typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement) {
    return anchor.getBoundingClientRect()
  }
  return anchor as DOMRect
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Viewport placement with flip and shift. Shared shape with the menu and tooltip,
 * but each primitive keeps its own copy so these files stay independent.
 */
export function placeAnchored(
  anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  size: { width: number; height: number },
  placement: VscodeOverlayPlacement,
  offset: number,
): { top: number; left: number } {
  const vw = typeof window === 'undefined' ? 0 : window.innerWidth
  const vh = typeof window === 'undefined' ? 0 : window.innerHeight
  const fits: Record<VscodeOverlayPlacement, boolean> = {
    top: anchor.top - offset - size.height >= VIEWPORT_MARGIN,
    bottom: anchor.bottom + offset + size.height <= vh - VIEWPORT_MARGIN,
    left: anchor.left - offset - size.width >= VIEWPORT_MARGIN,
    right: anchor.right + offset + size.width <= vw - VIEWPORT_MARGIN,
  }
  const opposite: Record<VscodeOverlayPlacement, VscodeOverlayPlacement> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
  }
  const resolved = fits[placement] ? placement : fits[opposite[placement]] ? opposite[placement] : placement

  if (resolved === 'top' || resolved === 'bottom') {
    const top = resolved === 'bottom' ? anchor.bottom + offset : anchor.top - offset - size.height
    return {
      top: clamp(top, VIEWPORT_MARGIN, vh - size.height - VIEWPORT_MARGIN),
      left: clamp(anchor.left + anchor.width / 2 - size.width / 2, VIEWPORT_MARGIN, vw - size.width - VIEWPORT_MARGIN),
    }
  }

  const left = resolved === 'right' ? anchor.right + offset : anchor.left - offset - size.width
  return {
    left: clamp(left, VIEWPORT_MARGIN, vw - size.width - VIEWPORT_MARGIN),
    top: clamp(anchor.top + anchor.height / 2 - size.height / 2, VIEWPORT_MARGIN, vh - size.height - VIEWPORT_MARGIN),
  }
}

export interface VscodePopoverProps {
  anchor: DOMRect | HTMLElement
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Default `bottom`; flips when the preferred side does not fit. */
  placement?: VscodeOverlayPlacement
  /** Gap between anchor and panel. Default 4px. */
  offset?: number
  /** `dialog` for interactive content, `tooltip` only for non-interactive hints. */
  role?: 'dialog' | 'tooltip'
  ariaLabel?: string
  className?: string
  children: ReactNode
}

/**
 * Anchored VS Code popover: 4px radius, menu background, 8px viewport margin,
 * flip/shift placement, outside-pointerdown dismissal, and Escape with focus
 * restored to whatever was focused before opening.
 *
 * Portals to body because the canvas transform makes fixed descendants position
 * relative to the zoomed canvas instead of the viewport.
 */
export function VscodePopover({
  anchor,
  open,
  onOpenChange,
  placement = 'bottom',
  offset = 4,
  role = 'dialog',
  ariaLabel,
  className,
  children,
}: VscodePopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const closeRef = useRef(onOpenChange)
  const anchorRef = useRef(anchor)
  closeRef.current = onOpenChange
  anchorRef.current = anchor

  useLayoutEffect(() => {
    if (!open) return
    const panel = rootRef.current
    if (!panel) return
    setPosition(
      placeAnchored(anchorRect(anchor), { width: panel.offsetWidth, height: panel.offsetHeight }, placement, offset),
    )
  }, [open, anchor, placement, offset])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = rootRef.current
    // Move focus into interactive content; an empty hint uses the panel itself.
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    ;(firstFocusable ?? panel)?.focus()

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel?.contains(target)) return
      const currentAnchor = anchorRef.current
      if (typeof HTMLElement !== 'undefined' && currentAnchor instanceof HTMLElement && currentAnchor.contains(target)) return
      closeRef.current(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current(false)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      if (previous?.isConnected) previous.focus()
    }
    // Anchor identity is read from a ref: a parent passing an inline DOMRect
    // would otherwise re-run this effect (and yank focus) on every render.
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      ref={rootRef}
      id={panelId}
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      data-slot="vscode-popover"
      data-placement={placement}
      className={['vscode-popover', className].filter(Boolean).join(' ')}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
