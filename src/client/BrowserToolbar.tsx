// Toolbar node browser: omnibox (`resolveOmniboxInput`: alamat/pencarian, lalu guard `parseBrowserUrl`), back/forward/reload/stop, toggle
// kendali agent. Ditempel WS-11 ke slot `renderToolbar`; tanpa state server (semua lewat props).
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import type { BrowserState, NAV_ACTIONS } from '../shared/browser.contract'
import { resolveOmniboxInput, type SearchEngine } from '../shared/browser.omnibox'
import { zoomLabel } from './browser.zoom'
import { TOOLBAR_TEXT, URL_ERROR_TEXT, ZOOM_TEXT } from './browser.uxText'
import BrowserAgentOffer from './browser.agentOffer'
import BrowserShieldsChip from './BrowserShieldsChip'
import { BrowserConsoleToggle } from './BrowserConsole'
import type { ConsoleSlot } from './BrowserConsole'

export interface BrowserToolbarProps {
  state?: BrowserState
  nav: (action: (typeof NAV_ACTIONS)[number], url?: string) => void
  agentControl: boolean
  /** false hanya bila user mematikan sub-opsi kendali agent (default on): toggle diganti tawaran untuk menyalakannya. */
  agentEnabled: boolean
  onAgentControl: (enabled: boolean) => void
  /** Nyalakan sub-opsi kendali agent di server (dipanggil setelah konfirmasi di tawaran). */
  onEnableAgent?: () => Promise<void>
  /** Zoom halaman (1 = 100%); kontrol zoom hanya tampil bila `onZoom` diberikan. */
  zoom?: number
  onZoom?: (dir: -1 | 1) => void
  /** Mesin pencari untuk ketikan yang bukan alamat (setting `browserSearchEngine`). */
  searchEngine?: SearchEngine
  /** Sakelar Shields situs ini; chip hanya tampil bila diberikan dan server menjalankan Shields. */
  onShields?: (on: boolean) => void
  /** Console drawer toggle; shown only when given. */
  console?: ConsoleSlot
}

/** Tooltips of the icon-only buttons: what the click does, plus why when disabled. */
const TIP = {
  back: 'Go back one page', backOff: 'no earlier page',
  forward: 'Go forward one page', forwardOff: 'no later page',
  reload: 'Reload this page', stop: 'Stop loading this page',
  zoomOut: 'Zoom the page out', zoomIn: 'Zoom the page in',
} as const

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

/** Bilah alamat + tombol navigasi + toggle agent untuk satu node browser. */
export default function BrowserToolbar({ state, nav, agentControl, agentEnabled, onAgentControl, onEnableAgent, zoom = 1, onZoom, searchEngine, onShields, console: consoleSlot }: BrowserToolbarProps) {
  const [draft, setDraft] = useState(state?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const stateUrl = state?.url ?? ''

  // Ikuti navigasi halaman (URL baru dari server menimpa ketikan yang belum dikirim).
  useEffect(() => { setDraft(stateUrl); setError(null) }, [stateUrl])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = resolveOmniboxInput(draft, searchEngine)
    if (!p) return
    if (!p.ok) { setError(URL_ERROR_TEXT[p.reason]); return }
    setError(null)
    nav('go', p.url)
  }

  return (
    <div role="toolbar" aria-label={TOOLBAR_TEXT.group} className="nodrag flex flex-col gap-1 p-1">
      <div className="flex flex-wrap items-center gap-1">
        <IconButton size="icon-xs" label={TOOLBAR_TEXT.back} tooltip={TIP.back} disabledReason={TIP.backOff} disabled={!state?.canBack} onClick={() => nav('back')}>{icon('arrow-left')}</IconButton>
        <IconButton size="icon-xs" label={TOOLBAR_TEXT.forward} tooltip={TIP.forward} disabledReason={TIP.forwardOff} disabled={!state?.canForward} onClick={() => nav('forward')}>{icon('arrow-right')}</IconButton>
        {state?.loading
          ? <IconButton size="icon-xs" label={TOOLBAR_TEXT.stop} tooltip={TIP.stop} onClick={() => nav('stop')}>{icon('debug-stop')}</IconButton>
          : <IconButton size="icon-xs" label={TOOLBAR_TEXT.reload} tooltip={TIP.reload} onClick={() => nav('reload')}>{icon('refresh')}</IconButton>}
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={submit}>
          <Input
            type="text" inputMode="url" spellCheck={false} autoComplete="off"
            aria-label={TOOLBAR_TEXT.urlLabel} placeholder={TOOLBAR_TEXT.urlPlaceholder}
            aria-invalid={error !== null} aria-describedby={error ? 'browser-url-error' : undefined}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
          />
          <Button type="submit" size="xs" variant="secondary">{TOOLBAR_TEXT.go}</Button>
        </form>
        {onZoom && (
          <div role="group" aria-label={ZOOM_TEXT.level} className="flex items-center gap-0.5 text-xs">
            <IconButton size="icon-xs" label={ZOOM_TEXT.out} tooltip={TIP.zoomOut} onClick={() => onZoom(-1)}>{icon('zoom-out')}</IconButton>
            <span className="min-w-9 text-center tabular-nums">{zoomLabel(zoom)}</span>
            <IconButton size="icon-xs" label={ZOOM_TEXT.in} tooltip={TIP.zoomIn} onClick={() => onZoom(1)}>{icon('zoom-in')}</IconButton>
          </div>
        )}
        {onShields && <BrowserShieldsChip state={state} onToggle={onShields} />}
        {consoleSlot && <BrowserConsoleToggle {...consoleSlot} />}
        {agentEnabled ? (
          <label className="flex items-center gap-1 text-xs whitespace-nowrap" title={TOOLBAR_TEXT.agentControlHint}>
            <input type="checkbox" checked={agentControl} onChange={(e) => onAgentControl(e.target.checked)} />
            {TOOLBAR_TEXT.agentControl}
          </label>
        ) : onEnableAgent && <BrowserAgentOffer enable={onEnableAgent} />}
      </div>
      {error && <p id="browser-url-error" role="alert" className="m-0 text-xs text-(--vscode-errorForeground)">{error}</p>}
    </div>
  )
}
