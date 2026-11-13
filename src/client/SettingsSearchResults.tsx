// Settings search results (./settings.search): a result count header, then one group per page with
// "Page › Label" rows (matched words marked) and their hint. Arrow keys move between rows (VS Code,
// Raycast); a row opens its page and reveals the field.
import type { SearchGroupId, SettingsSearchEntry } from './settings.search'
import { highlightMatches } from './SettingsFieldRow'

export const RESULTS_TEXT = {
  count: (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'result' : 'results'}`,
  none: (q: string): string => `No settings match “${q}”.`,
} as const

/** Focus the first result row inside `root` (search box ArrowDown). */
export function focusFirstResult(root: HTMLElement | null): void {
  root?.querySelector<HTMLButtonElement>('.st-result-go')?.focus()
}

function onResultsKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.st-result-go'))
  const i = rows.findIndex((row) => row === document.activeElement)
  if (i < 0) return
  event.preventDefault()
  rows[Math.min(rows.length - 1, Math.max(0, i + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}

export function SettingsSearchResults({ query, normalized, results, labelOf, onGo }: {
  query: string
  normalized: string
  results: readonly { page: SearchGroupId; entries: SettingsSearchEntry[] }[]
  labelOf(page: SearchGroupId): string
  onGo(entry: SettingsSearchEntry): void
}): React.JSX.Element {
  const found = results.reduce((n, g) => n + g.entries.length, 0)
  if (!found) return <p className="st-no-results" role="status">{RESULTS_TEXT.none(query.trim())}</p>
  return (
    <div className="st-page" onKeyDown={onResultsKeyDown}>
      <p className="st-search-count" role="status">{RESULTS_TEXT.count(found)}</p>
      {results.map(({ page, entries }) => (
        <section key={page} className="st-search-group st-group" aria-labelledby={`st-group-${page}`}>
          <h3 id={`st-group-${page}`} className="st-group-title">{labelOf(page)}</h3>
          <ul className="st-results st-group-card">
            {entries.map((entry) => (
              <li key={entry.field ?? `${page}:${entry.label}`} className="st-result">
                <button type="button" className="st-result-go" onClick={() => onGo(entry)}>
                  {entry.label === labelOf(page)
                    ? highlightMatches(entry.label, normalized)
                    : <><span className="st-result-path">{labelOf(page)} ›</span> {highlightMatches(entry.label, normalized)}</>}
                </button>
                {entry.hint ? <p className="st-hint">{entry.hint}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
