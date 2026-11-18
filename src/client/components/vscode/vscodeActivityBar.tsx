import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import './vscode-shell.css'

/** One icon rail entry. `active` is owned by the caller through `activeId`. */
export interface VscodeActivityBarItem {
  id: string
  label: string
  icon: ReactNode
  /** Count shown bottom-right. Values over 99 render as `99+`. */
  badge?: number
  disabled?: boolean
  /** ⌘K registry command whose keybinding the tooltip shows. */
  commandId?: string
  /** Tooltip text when it should say more than `label` (e.g. the unread count). */
  tooltip?: string
}

export interface VscodeActivityBarProps {
  items: VscodeActivityBarItem[]
  /** Bottom-anchored entries (settings, account). */
  bottomItems?: VscodeActivityBarItem[]
  /** Controlled active entry; `aria-current="page"` follows this value. */
  activeId?: string | null
  /** Extra active entries for independent areas (sidebar and panel); same look as `activeId`. */
  activeIds?: readonly string[]
  onSelect: (id: string) => void
  className?: string
  /** Accessible name for the rail; defaults to `Activity bar`. */
  ariaLabel?: string
}

function badgeText(badge: number | undefined): string | null {
  if (badge === undefined || badge <= 0) return null
  return badge > 99 ? '99+' : String(badge)
}

/**
 * VS Code activity bar: a 48px rail of 48x48 icon buttons with a 24px icon and a
 * 2px accent indicator on the active entry (`aria-current="page"`).
 *
 * Arrow keys move focus between entries (wrapping), Home/End jump to the ends, and
 * the rail is a single Tab stop per entry so native tab order still works. The
 * caller owns selection through `activeId`; clicking only reports the id.
 */
export function VscodeActivityBar({
  items,
  bottomItems = [],
  activeId = null,
  activeIds = [],
  onSelect,
  className,
  ariaLabel = 'Activity bar',
}: VscodeActivityBarProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const all = [...items, ...bottomItems]

  const focusAt = (index: number) => {
    if (all.length === 0) return
    const wrapped = ((index % all.length) + all.length) % all.length
    buttonRefs.current[wrapped]?.focus()
  }

  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault()
        focusAt(index + 1)
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault()
        focusAt(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusAt(0)
        break
      case 'End':
        event.preventDefault()
        focusAt(all.length - 1)
        break
      default:
        break
    }
  }

  const renderItem = (item: VscodeActivityBarItem, index: number) => {
    const active = item.id === activeId || activeIds.includes(item.id)
    const count = badgeText(item.badge)
    return (
      <IconTooltip key={item.id} label={item.tooltip ?? item.label} commandId={item.commandId} side="right" disabled={item.disabled}>
        <button
          ref={(element) => {
            buttonRefs.current[index] = element
          }}
          type="button"
          data-slot="vscode-activity-bar-item"
          data-active={active ? 'true' : 'false'}
          data-label={item.label}
          className="vscode-activity-bar__item"
          aria-label={count ? `${item.label}, ${count}` : item.label}
          aria-current={active ? 'page' : undefined}
          disabled={item.disabled}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => onItemKeyDown(event, index)}
        >
          <span className="vscode-activity-bar__icon" data-slot="vscode-activity-bar-icon" aria-hidden="true">
            {item.icon}
          </span>
          {count ? (
            <span className="vscode-activity-bar__badge" data-slot="vscode-activity-bar-badge" aria-hidden="true">
              {count}
            </span>
          ) : null}
        </button>
      </IconTooltip>
    )
  }

  return (
    <nav className={['vscode-activity-bar', className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
      <div className="vscode-activity-bar__group" data-slot="vscode-activity-bar-top">
        {items.map((item, index) => renderItem(item, index))}
      </div>
      {bottomItems.length > 0 ? (
        <div className="vscode-activity-bar__group" data-slot="vscode-activity-bar-bottom">
          {bottomItems.map((item, index) => renderItem(item, items.length + index))}
        </div>
      ) : null}
    </nav>
  )
}
