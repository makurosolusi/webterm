// Halaman awal node browser: kotak cari/URL, grid pintasan, daftar terbaru. Murni UI; navigasi
// dilakukan lewat `onGo` milik pemanggil, jadi semua jalur memakai validasi server yang sama.
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { loadRecent } from './browser.recent'
import { SHORTCUTS } from './browser.startpage.data'
import { DEFAULT_SEARCH_ENGINE, resolveOmniboxInput, SEARCH_ENGINES, toSearchEngine, type SearchEngine } from '../shared/browser.omnibox'
import { START_TEXT } from './browser.uxText'

/** Halaman awal; `onGo(url)` dipanggil dengan URL http(s) final. */
export default function BrowserStartPage({ onGo, searchEngine = DEFAULT_SEARCH_ENGINE }: { onGo: (url: string) => void; searchEngine?: SearchEngine }) {
  const [draft, setDraft] = useState('')
  // Dibaca sekali per kemunculan: halaman ini dibongkar begitu ada URL, jadi selalu segar saat muncul lagi.
  const [recent] = useState(loadRecent)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Skema terlarang (javascript:/file:) ditolak guard: tak ada navigasi, sama seperti di toolbar.
    const p = resolveOmniboxInput(draft, searchEngine)
    if (p?.ok) onGo(p.url)
  }

  return (
    <div className="browser-start nodrag nowheel nopan nokey" role="region" aria-label={START_TEXT.page}>
      <form className="browser-start-search" onSubmit={submit}>
        <Input
          type="text" spellCheck={false} autoComplete="off"
          aria-label={START_TEXT.searchLabel} placeholder={START_TEXT.searchPlaceholder(SEARCH_ENGINES[toSearchEngine(searchEngine)].label)}
          value={draft} onChange={(e) => setDraft(e.target.value)}
        />
      </form>
      <ul className="browser-start-grid" aria-label={START_TEXT.shortcuts}>
        {SHORTCUTS.map((s) => (
          <li key={s.id}>
            <Button type="button" variant="ghost" className="browser-start-tile" aria-label={START_TEXT.open(s.label)} onClick={() => onGo(s.url)}>
              <span className="browser-start-icon" style={{ background: s.color }} aria-hidden="true">{s.initial}</span>
              <span className="browser-start-name">{s.label}</span>
            </Button>
          </li>
        ))}
      </ul>
      {recent.length > 0 && (
        <section aria-label={START_TEXT.recent}>
          <h3 className="browser-start-heading">{START_TEXT.recent}</h3>
          <ul className="browser-start-recent">
            {recent.map((r) => (
              <li key={r.host}>
                <Button type="button" variant="ghost" className="browser-start-item" onClick={() => onGo(r.url)}>
                  <span className="browser-start-title">{r.title || r.host}</span>
                  <span className="browser-start-host">{r.host}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
