// New-tab page: a focused address field and the recently closed tabs (the Ctrl+Shift+T history).
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { validateTabUrl, type BrowserTab } from '../../shared/browser.tabs'
import { hostOf, tabTitle } from './browserTabs.labels'

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i

/** Turns what the user typed into an http(s) URL, or an error line. "example.com" gets https, "localhost:3000" http. */
export function normalizeAddress(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'Enter a web address' }
  let url = text
  if (/\s/.test(text)) return { ok: false, reason: 'Enter a web address, like example.com' }
  if (!SCHEME.test(text) && !/^(about|javascript|data|file):/i.test(text)) {
    if (LOCAL_HOST.test(text)) url = `http://${text}`
    else if (text.includes('.')) url = `https://${text}`
    else return { ok: false, reason: 'Enter a web address, like example.com' }
  }
  return validateTabUrl(url)
}

export interface BrowserNewTabPageProps {
  closed: BrowserTab[]
  onNavigate: (url: string) => void
  /** Reopen one entry of `closed` (a new tab id is stamped by the parent). */
  onReopen: (closedTabId: string) => void
  /** Why a reopen cannot run right now (tab limit); disables the rows with the reason shown. */
  reopenBlockedReason?: string
}

export function BrowserNewTabPage({ closed, onNavigate, onReopen, reopenBlockedReason }: BrowserNewTabPageProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const r = normalizeAddress(text)
    if (r.ok) { setError(null); onNavigate(r.url) } else setError(r.reason)
  }
  return (
    <section className="bt-page" aria-label="New tab">
      <h2>New tab</h2>
      <form className="bt-address" onSubmit={submit} noValidate>
        <Input
          autoFocus
          data-tab-shortcuts
          aria-label="Web address"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'bt-address-error' : undefined}
          placeholder="Search or enter a web address"
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null) }}
        />
        <Button type="submit" size="sm">Go</Button>
      </form>
      {error && <p id="bt-address-error" role="alert" className="bt-form-error">{error}</p>}
      <div className="bt-closed">
        <h3>Recently closed</h3>
        {closed.length === 0 && <p>No recently closed tabs</p>}
        {reopenBlockedReason && closed.length > 0 && <p role="status">{reopenBlockedReason}</p>}
        {closed.map((t) => (
          <Button key={t.tabId} variant="ghost" size="sm" className="bt-closed-row" disabled={!!reopenBlockedReason} onClick={() => onReopen(t.tabId)}>
            <span>{tabTitle(t)}</span>
            <span className="bt-closed-host">{hostOf(t.url)}</span>
          </Button>
        ))}
      </div>
    </section>
  )
}
