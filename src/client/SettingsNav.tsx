// Settings sidebar (macOS System Settings / Linear): the search box at the top of the column, then
// single-line items (icon + title; the description lives in the page header) under group headings,
// inset rounded pills with a soft selection whether or not the list has focus. Arrow/Home/End move
// focus across groups. Narrow (`NARROW_QUERY`): the search box above a section dropdown.
import { forwardRef } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'

/** Below this width the sidebar becomes a section dropdown. The only width breakpoint of the shell:
 *  CSS follows it through `.is-narrow`, so JS and CSS cannot disagree (the old 719/720 px gap). */
export const NARROW_QUERY = '(max-width: 719px)'

export const NAV_TEXT = {
  search: 'Search settings',
  clear: 'Clear search',
  clearTip: 'Clear Search Results',
  nav: 'Section settings',
  picker: 'Settings section',
} as const

interface SearchProps {
  query: string
  onQuery(q: string): void
  /** Enter: open the first result. */
  onEnter(): void
  /** ArrowDown: move into the results. */
  onDown(): void
}

/** The one search box; ⌘F or `/` focuses it while Settings is open (SettingsPanel). */
export const SettingsSearchBox = forwardRef<HTMLInputElement, SearchProps>(function SettingsSearchBox({ query, onQuery, onEnter, onDown }, ref) {
  return (
    <div className="st-search-wrap">
      <span className="codicon codicon-search st-search-icon" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        className="st-search"
        aria-label={NAV_TEXT.search}
        placeholder={NAV_TEXT.search}
        value={query}
        autoFocus
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && query.trim()) { event.preventDefault(); onEnter() }
          else if (event.key === 'ArrowDown' && query.trim()) { event.preventDefault(); onDown() }
        }}
      />
      {query ? (
        <IconTooltip label={NAV_TEXT.clearTip}>
          <button type="button" className="st-search-clear" aria-label={NAV_TEXT.clear} onClick={() => onQuery('')}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </IconTooltip>
      ) : null}
    </div>
  )
})

interface NavProps {
  active: SectionId
  /** True while searching: no item is current. */
  searching: boolean
  shown(id: SectionId): boolean
  onOpen(id: SectionId): void
}

const visibleGroups = (shown: (id: SectionId) => boolean) =>
  SETTINGS_GROUPS.map((group, index) => ({ group, index, sections: SETTINGS_SECTIONS.filter((x) => x.group === group && shown(x.id)) }))
    .filter((g) => g.sections.length)

/** Roving focus like VS Code's tree: arrows/Home/End move focus, Enter/Space select. */
function onTocKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button.st-nav'))
  const index = items.findIndex((item) => item === document.activeElement)
  const target =
    event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : null
  if (target === null || index < 0) return
  event.preventDefault()
  items[Math.min(items.length - 1, Math.max(0, target))]?.focus()
}

export function SettingsNavList({ active, searching, shown, onOpen }: NavProps): React.JSX.Element {
  return (
    <nav className="st-nav-list" aria-label={NAV_TEXT.nav} onKeyDown={onTocKeyDown}>
      {visibleGroups(shown).map(({ group, index, sections }) => (
        <div key={group} role="group" className="st-nav-group" aria-labelledby={`st-nav-group-${index}`}>
          <div id={`st-nav-group-${index}`} className="st-nav-group-title">{group}</div>
          {sections.map((section) => {
            const current = active === section.id && !searching
            return (
              <button key={section.id} type="button" aria-current={current} className={'st-nav' + (current ? ' is-active' : '')}
                onClick={() => onOpen(section.id)}>
                <span className={`codicon codicon-${section.icon} st-nav-icon`} aria-hidden="true" />
                <span className="st-nav-label">{section.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function SettingsSectionPicker({ active, shown, onOpen }: Omit<NavProps, 'searching'>): React.JSX.Element {
  return (
    <span className="st-select-wrap">
      <select className="st-select" aria-label={NAV_TEXT.picker} value={active} onChange={(event) => onOpen(event.target.value as SectionId)}>
        {visibleGroups(shown).map(({ group, sections }) => (
          <optgroup key={group} label={group}>
            {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
          </optgroup>
        ))}
      </select>
      <span className="codicon codicon-chevron-down st-select-chevron" aria-hidden="true" />
    </span>
  )
}
