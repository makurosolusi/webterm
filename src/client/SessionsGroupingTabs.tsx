// Pemilih pengelompokan sidebar (Project / Status / Nodes) sebagai tab ala VS Code: tablist native
// dengan roving tabindex dan aktivasi otomatis oleh panah, supaya terbaca sebagai `tablist/tab`.
import type { KeyboardEvent } from 'react'
import type { SidebarGrouping } from './sessionList'

const TABS: ReadonlyArray<readonly [SidebarGrouping, string]> = [
  ['project', 'Project'],
  ['status', 'Status'],
  ['nodes', 'Nodes'],
]

export interface SessionsGroupingTabsProps {
  value: SidebarGrouping
  onChange: (value: SidebarGrouping) => void
}

/** Tab pengelompokan; Left/Right/Home/End memindah tab sekaligus fokusnya. */
export function SessionsGroupingTabs({ value, onChange }: SessionsGroupingTabsProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex(([g]) => g === value)
    const next =
      e.key === 'ArrowRight' ? (current + 1) % TABS.length
      : e.key === 'ArrowLeft' ? (current - 1 + TABS.length) % TABS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? TABS.length - 1
      : -1
    if (next < 0) return
    e.preventDefault()
    e.stopPropagation()
    onChange(TABS[next][0])
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="ss-tabs" role="tablist" aria-label="Group sessions by" onKeyDown={onKeyDown}>
      {TABS.map(([g, label]) => (
        <button
          key={g}
          type="button"
          role="tab"
          className="ss-tab"
          aria-selected={g === value}
          tabIndex={g === value ? 0 : -1}
          onClick={() => onChange(g)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
