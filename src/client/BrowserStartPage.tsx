// Halaman awal node browser: kotak cari/URL, grid pintasan, daftar terbaru. Murni UI; navigasi
// dilakukan lewat `onGo` milik pemanggil, jadi semua jalur memakai validasi server yang sama.
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '@/components/ui/input'
import { loadRecent } from './browser.recent'
import { SHORTCUTS } from './browser.startpage.data'
import { resolveStartInput } from './browser.startpage.resolve'
import { START_TEXT } from './browser.uxText'

/** Halaman awal; `onGo(url)` dipanggil dengan URL http(s) final. */
export default function BrowserStartPage({ onGo }: { onGo: (url: string) => void }) {
  const [draft, setDraft] = useState('')
  // Dibaca sekali per kemunculan: halaman ini dibongkar begitu ada URL, jadi selalu segar saat muncul lagi.
  const [recent] = useState(loadRecent)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const url = resolveStartInput(draft)
    if (url) onGo(url)
  }

  return (
    <div className="browser-start nodrag nowheel nopan nokey" role="region" aria-label={START_TEXT.page}>
      <form className="browser-start-search" onSubmit={submit}>
        <Input
          type="text" spellCheck={false} autoComplete="off"
          aria-label={START_TEXT.searchLabel} placeholder={START_TEXT.searchPlaceholder}
          value={draft} onChange={(e) => setDraft(e.target.value)}
        />
      </form>
      <ul className="browser-start-grid" aria-label={START_TEXT.shortcuts}>
        {SHORTCUTS.map((s) => (
          <li key={s.id}>
            <button type="button" className="browser-start-tile" aria-label={START_TEXT.open(s.label)} onClick={() => onGo(s.url)}>
              <span className="browser-start-icon" style={{ background: s.color }} aria-hidden="true">{s.initial}</span>
              <span className="browser-start-name">{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {recent.length > 0 && (
        <section aria-label={START_TEXT.recent}>
          <h3 className="browser-start-heading">{START_TEXT.recent}</h3>
          <ul className="browser-start-recent">
            {recent.map((r) => (
              <li key={r.host}>
                <button type="button" className="browser-start-item" onClick={() => onGo(r.url)}>
                  <span className="browser-start-title">{r.title || r.host}</span>
                  <span className="browser-start-host">{r.host}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
