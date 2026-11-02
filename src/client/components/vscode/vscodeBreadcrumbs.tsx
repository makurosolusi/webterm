import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './vscode-shell.css'

export interface VscodeBreadcrumbSegment {
  id: string
  label: string
  title?: string
  icon?: ReactNode
  /** When omitted the segment renders as static text (e.g. the project root). */
  onClick?: () => void
}

export interface VscodeBreadcrumbsProps {
  segments: VscodeBreadcrumbSegment[]
  /**
   * Maximum rendered segments. When exceeded, the oldest segments collapse into a
   * leading ellipsis menu. `0` (default) renders every segment.
   */
  maxVisible?: number
  onSelect?: (id: string) => void
  className?: string
  ariaLabel?: string
  overflowLabel?: string
}

function Chevron() {
  return (
    <span className="vscode-breadcrumbs__separator" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
        <path
          d="M6 3.5L10.5 8 6 12.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/**
 * VS Code breadcrumbs: 22px tall, 12px, chevrons between segments, the last segment
 * in the foreground color and ancestors muted.
 *
 * Overflow collapses from the left into a leading ellipsis menu; the menu is a real
 * `role="menu"` with ArrowUp/ArrowDown/Home/End and Escape support.
 */
export function VscodeBreadcrumbs({
  segments,
  maxVisible = 0,
  onSelect,
  className,
  ariaLabel = 'Breadcrumbs',
  overflowLabel = 'Show hidden path segments',
}: VscodeBreadcrumbsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rootRef = useRef<HTMLElement>(null)

  const limit = maxVisible > 0 ? maxVisible : segments.length
  let hidden: VscodeBreadcrumbSegment[] = []
  let visible = segments
  if (segments.length > limit) {
    const visibleCount = Math.max(1, limit - 1)
    hidden = segments.slice(0, segments.length - visibleCount)
    visible = segments.slice(segments.length - visibleCount)
  }

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    itemRefs.current[0]?.focus()
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  const select = (segment: VscodeBreadcrumbSegment) => {
    segment.onClick?.()
    onSelect?.(segment.id)
    setMenuOpen(false)
  }

  const moveMenuFocus = (from: number, delta: 1 | -1) => {
    if (hidden.length === 0) return
    const next = (from + delta + hidden.length) % hidden.length
    itemRefs.current[next]?.focus()
  }

  return (
    <nav
      ref={rootRef}
      className={['vscode-breadcrumbs', className].filter(Boolean).join(' ')}
      data-slot="vscode-breadcrumbs"
      aria-label={ariaLabel}
    >
      <ol className="vscode-breadcrumbs__list">
        {hidden.length > 0 ? (
          <li className="vscode-breadcrumbs__item vscode-breadcrumbs__item--overflow" role="none">
            <button
              ref={triggerRef}
              type="button"
              data-slot="vscode-breadcrumbs-overflow"
              className="vscode-breadcrumbs__overflow"
              aria-label={overflowLabel}
              title={overflowLabel}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              …
            </button>
            {menuOpen ? (
              <div
                className="vscode-breadcrumbs__menu"
                role="menu"
                aria-label={overflowLabel}
              >
                {hidden.map((segment, index) => (
                  <button
                    key={segment.id}
                    ref={(element) => {
                      itemRefs.current[index] = element
                    }}
                    type="button"
                    role="menuitem"
                    data-slot="vscode-breadcrumbs-menu-item"
                    className="vscode-breadcrumbs__menu-item"
                    onClick={() => select(segment)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        event.stopPropagation()
                        moveMenuFocus(index, event.key === 'ArrowDown' ? 1 : -1)
                      } else if (event.key === 'Home') {
                        event.preventDefault()
                        itemRefs.current[0]?.focus()
                      } else if (event.key === 'End') {
                        event.preventDefault()
                        itemRefs.current[hidden.length - 1]?.focus()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        setMenuOpen(false)
                        triggerRef.current?.focus()
                      }
                    }}
                  >
                    {segment.icon ? (
                      <span className="vscode-breadcrumbs__menu-icon" aria-hidden="true">
                        {segment.icon}
                      </span>
                    ) : null}
                    <span className="vscode-breadcrumbs__menu-label">{segment.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ) : null}
        {visible.map((segment, index) => {
          const last = index === visible.length - 1
          const interactive = Boolean(segment.onClick || onSelect)
          return (
            <li key={segment.id} className="vscode-breadcrumbs__item" role="none">
              {hidden.length > 0 || index > 0 ? <Chevron /> : null}
              {interactive ? (
                <button
                  type="button"
                  data-slot="vscode-breadcrumbs-segment"
                  className="vscode-breadcrumbs__segment"
                  data-current={last ? 'true' : 'false'}
                  aria-current={last ? 'page' : undefined}
                  title={segment.title ?? segment.label}
                  onClick={() => select(segment)}
                >
                  {segment.icon ? (
                    <span className="vscode-breadcrumbs__icon" aria-hidden="true">
                      {segment.icon}
                    </span>
                  ) : null}
                  {segment.label}
                </button>
              ) : (
                <span
                  data-slot="vscode-breadcrumbs-segment"
                  className="vscode-breadcrumbs__segment"
                  data-current={last ? 'true' : 'false'}
                  aria-current={last ? 'page' : undefined}
                  title={segment.title ?? segment.label}
                >
                  {segment.icon ? (
                    <span className="vscode-breadcrumbs__icon" aria-hidden="true">
                      {segment.icon}
                    </span>
                  ) : null}
                  {segment.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
