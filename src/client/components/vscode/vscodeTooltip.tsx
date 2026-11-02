import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import './vscode-overlay.css'
import { placeAnchored, type VscodeOverlayPlacement } from './vscodePopover'

const HIDE_DELAY = 100
const GAP = 4

function mergeRefs<T>(a: Ref<T>, b: Ref<T> | undefined): (value: T | null) => void {
  return (value) => {
    if (typeof a === 'function') a(value)
    else if (a) (a as { current: T | null }).current = value
    if (typeof b === 'function') b(value)
    else if (b) (b as { current: T | null }).current = value
  }
}

interface TriggerProps {
  ref?: Ref<HTMLElement>
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void
  onFocus?: (event: unknown) => void
  onBlur?: (event: unknown) => void
  onKeyDown?: (event: unknown) => void
  'aria-describedby'?: string
}

export interface VscodeTooltipProps {
  content: ReactNode
  /** Default `top`; flips when the preferred side does not fit. */
  side?: VscodeOverlayPlacement
  /** Hover delay; keyboard focus shows immediately. Default 500ms. */
  delayMs?: number
  children: ReactElement
}

/**
 * VS Code hover hint: 500ms hover delay, 100ms hide delay, 13px text, max-width
 * 500px, 4px 8px padding, 2px radius. Focus shows it immediately.
 *
 * The tooltip is a portal and keeps itself open while hovered, so a user can move
 * the pointer from trigger to hint without it disappearing. `aria-describedby`
 * points at the hint only while it is visible; an always-present description would
 * be announced twice by some screen readers.
 */
export function VscodeTooltip({ content, side = 'top', delayMs = 500, children }: VscodeTooltipProps) {
  const tooltipId = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const showTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  const clearTimers = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    showTimer.current = null
    hideTimer.current = null
  }

  const show = (delay: number) => {
    clearTimers()
    if (delay <= 0) {
      setVisible(true)
      return
    }
    showTimer.current = window.setTimeout(() => setVisible(true), delay)
  }

  const hide = (delay = HIDE_DELAY) => {
    clearTimers()
    if (delay <= 0) {
      setVisible(false)
      return
    }
    hideTimer.current = window.setTimeout(() => setVisible(false), delay)
  }

  useEffect(() => clearTimers, [])

  useLayoutEffect(() => {
    if (!visible) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    const tooltip = tooltipRef.current
    if (!trigger || !tooltip) return
    setPosition(
      placeAnchored(trigger.getBoundingClientRect(), { width: tooltip.offsetWidth, height: tooltip.offsetHeight }, side, GAP),
    )
  }, [visible, side])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setVisible(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible])

  const childProps = children.props as TriggerProps
  const describedBy = [childProps['aria-describedby'], visible ? tooltipId : undefined].filter(Boolean).join(' ')

  const trigger = cloneElement(children as ReactElement<TriggerProps>, {
    ...childProps,
    ref: mergeRefs(triggerRef, childProps.ref),
    'aria-describedby': describedBy || undefined,
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      childProps.onPointerEnter?.(event)
      show(delayMs)
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(event)
      hide()
    },
    onFocus: (event: unknown) => {
      childProps.onFocus?.(event)
      show(0)
    },
    onBlur: (event: unknown) => {
      childProps.onBlur?.(event)
      hide()
    },
    onKeyDown: (event: unknown) => {
      childProps.onKeyDown?.(event)
      if ((event as { key?: string }).key === 'Escape') hide(0)
    },
  })

  return (
    <>
      {trigger}
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            data-slot="vscode-tooltip"
            className="vscode-tooltip"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? 'visible' : 'hidden',
            }}
            onPointerEnter={() => clearTimers()}
            onPointerLeave={() => hide()}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
