// Browser start page (Chrome's new-tab page): search "fakebox", shortcut grid, recent list. UI only; navigation goes
// through the caller's `onGo`, so every path uses the same server-side validation.
import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { loadRecent } from './browser.recent'
import BrowserFavicon from './browser.favicon'
import BrowserShortcuts from './BrowserShortcuts'
import { DEFAULT_SEARCH_ENGINE, resolveOmniboxInput, SEARCH_ENGINES, toSearchEngine, type SearchEngine } from '../shared/browser.omnibox'
import { START_TEXT } from './browser.uxText'
import { omniboxOf } from './browser.omniboxDom'

/**
 * Chrome's fakebox: focus and typing move to the real omnibox, so the node has ONE address input. The omnibox is a
 * React-controlled input in the toolbar, so the text goes in through the native value setter + an `input` event
 * (what React's onChange listens to), not by reaching into the toolbar's state.
 */
function handOff(omnibox: HTMLInputElement, text: string): void {
  if (text) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(omnibox, omnibox.value + text)
    omnibox.dispatchEvent(new Event('input', { bubbles: true }))
  }
  omnibox.focus()
  const end = omnibox.value.length
  omnibox.setSelectionRange(end, end)
}

/** Start page; `onGo(url)` is called with the final http(s) URL. */
export default function BrowserStartPage({ onGo, searchEngine = DEFAULT_SEARCH_ENGINE }: { onGo: (url: string) => void; searchEngine?: SearchEngine }) {
  const [draft, setDraft] = useState('')
  // Read once per appearance: the page unmounts as soon as there is a URL, so it is fresh when it shows again.
  const [recent] = useState(loadRecent)

  // Without a toolbar (node rendered bare) the box stays a working search field of its own.
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const omnibox = omniboxOf(e.currentTarget)
    if (omnibox) { handOff(omnibox, e.target.value); setDraft('') } else setDraft(e.target.value)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Forbidden schemes (javascript:/file:) are rejected by the guard: no navigation, same as the toolbar.
    const p = resolveOmniboxInput(draft, searchEngine)
    if (p?.ok) onGo(p.url)
  }

  return (
    <div className="browser-start nodrag nowheel nopan nokey" role="region" aria-label={START_TEXT.page}>
      <form className="browser-start-search" onSubmit={submit}>
        <span className="browser-start-search__icon codicon codicon-search" aria-hidden="true" />
        <Input
          type="text" spellCheck={false} autoComplete="off"
          aria-label={START_TEXT.searchLabel} placeholder={START_TEXT.searchPlaceholder(SEARCH_ENGINES[toSearchEngine(searchEngine)].label)}
          value={draft} onChange={onChange}
          onFocus={(e) => { const o = omniboxOf(e.currentTarget); if (o) handOff(o, '') }}
        />
      </form>
      <BrowserShortcuts onGo={onGo} />
      {recent.length > 0 && (
        <section className="browser-start-section" aria-label={START_TEXT.recent}>
          <h3 className="browser-start-heading">{START_TEXT.recent}</h3>
          <ul className="browser-start-recent">
            {recent.map((r) => (
              <li key={r.host}>
                <Button type="button" variant="ghost" className="browser-start-item" onClick={() => onGo(r.url)}>
                  <BrowserFavicon className="browser-start-favicon" url={r.url} label={r.title || r.host} />
                  <span className="browser-start-text">
                    <span className="browser-start-title">{r.title || r.host}</span>
                    <span className="browser-start-host">{r.host}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
