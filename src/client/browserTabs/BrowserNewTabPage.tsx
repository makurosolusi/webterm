// New-tab page: a focused address field and the recently closed tabs (the Ctrl+Shift+T history).
import { useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { resolveOmniboxInput, SEARCH_ENGINES, toSearchEngine } from '../../shared/browser.omnibox'
import type { UrlRejectReason } from '../../shared/browser.url'
import type { BrowserTab } from '../../shared/browser.tabs'
import { useLiveSettings } from '../useSettings'
import { hostOf, tabTitle } from './browserTabs.labels'

const REJECT_TEXT: Record<UrlRejectReason, string> = {
  invalid: 'That address can\u2019t be opened: it is not a valid address.',
  scheme: 'That address can\u2019t be opened: unsupported scheme. Only http and https work.',
  userinfo: 'That address can\u2019t be opened: it contains a username or password.',
  too_long: 'That address can\u2019t be opened: it is too long.',
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
  const engineKey = toSearchEngine(useLiveSettings().browserSearchEngine)
  const engine = SEARCH_ENGINES[engineKey].label
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const r = resolveOmniboxInput(text, engineKey)
    if (!r) return // empty: nothing to do, no error
    if (r.ok) { setError(null); onNavigate(r.url) } else setError(REJECT_TEXT[r.reason])
  }
  return (
    <section className="bt-page" aria-label="New tab">
      <h2>New tab</h2>
      <form className="bt-address" onSubmit={submit} noValidate>
        <div className="bt-address-field">
          <Search className="bt-address-icon" aria-hidden="true" />
          <Input
            autoFocus
            data-tab-shortcuts
            aria-label="Web address"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'bt-address-error' : undefined}
            placeholder={`Search ${engine} or enter a web address`}
            value={text}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => { setText(e.target.value); setError(null) }}
          />
        </div>
        <Button type="submit" className="bt-address-go" disabled={!text.trim()}>Go</Button>
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
