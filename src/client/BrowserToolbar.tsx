// Toolbar of a browser node, one row like Chrome/Arc/VS Code Simple Browser: back, forward, reload↔stop, the address
// field (search icon on an empty page, site-info icon on a loaded one, zoom pill, Shields chip; Enter navigates, recent
// pages as suggestions), the console error badge, the icon-only Agents toggle and Chrome's "⋮" for page actions — the
// only browser menu (the node header's "…" keeps node actions). No server state here (everything via props). Narrow
// nodes drop forward and the in-field extras by container query (browser.css `.browser-toolbar`); ⋮ still has them.
import { useEffect, useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import type { BrowserState, NAV_ACTIONS } from '../shared/browser.contract'
import { resolveOmniboxInput, type SearchEngine } from '../shared/browser.omnibox'
import { ZOOM_STEP, zoomLabel } from './browser.zoom'
import { SITE_INFO_TEXT, TOOLBAR_TEXT, TOOLBAR_TIP as TIP, URL_ERROR_TEXT, ZOOM_TEXT } from './browser.uxText'
import { loadRecent } from './browser.recent'
import BrowserShieldsChip from './BrowserShieldsChip'
import BrowserToolbarMenu from './BrowserToolbarMenu'
import type { DeviceChoice } from '../shared/browser.devices'
import { CONSOLE_COMMAND_ID, CONSOLE_TEXT } from './BrowserConsole'
import type { ConsoleSlot } from './BrowserConsole'
import type { DesignMode } from './browser/design/useDesignMode'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { isBlankUrl } from './browser.useGoto'

export interface BrowserToolbarProps {
  state?: BrowserState
  nav: (action: (typeof NAV_ACTIONS)[number], url?: string) => void
  agentControl: boolean
  /** false only when the user turned the agent-control sub-option off (default on): the menu offers to turn it on instead. */
  agentEnabled: boolean
  onAgentControl: (enabled: boolean) => void
  /** Turns the agent-control sub-option on at the server (called after the offer's confirmation). */
  onEnableAgent?: () => Promise<void>
  /** Page zoom (1 = 100%); zoom controls appear only when `onZoom` is given. */
  zoom?: number
  onZoom?: (dir: -1 | 1) => void
  /** Back to 100%; without it the toolbar steps back with `onZoom`. */
  onZoomReset?: () => void
  /** Search engine for input that is not an address (setting `browserSearchEngine`). */
  searchEngine?: SearchEngine
  /** Shields toggle for this site; the chip shows only when given and the server runs Shields. */
  onShields?: (on: boolean) => void
  /** Device mode (menu row shown only when given). */
  device?: DeviceChoice
  onDevice?: (device: DeviceChoice | null) => void
  /** Console drawer toggle; the error badge shows only when given and there are errors. */
  console?: ConsoleSlot
  /** Design Mode state (menu toggle shown only when given). */
  design?: DesignMode
  /** Extra page/browser rows at the end of the ⋮ menu (e.g. Import Cookies). */
  menuItems?: VscodeMenuItem[]
}

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

/** Site-info kind from the page URL scheme, like Chrome's lock / "Not secure" chip; no page yet = search. */
export function siteInfoKind(url: string): keyof typeof SITE_INFO_TEXT {
  if (isBlankUrl(url)) return 'empty'
  if (url.startsWith('https:')) return 'secure'
  if (url.startsWith('http:')) return 'insecure'
  return 'other'
}

/** Address bar + navigation + overflow menu of one browser node. */
export default function BrowserToolbar({ state, nav, agentControl, agentEnabled, onAgentControl, onEnableAgent, zoom = 1, onZoom, onZoomReset, searchEngine, onShields, device, onDevice, console: consoleSlot, design, menuItems }: BrowserToolbarProps) {
  const [draft, setDraft] = useState(state?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const stateUrl = state?.url ?? ''
  const listId = useId()
  // Re-read on each navigation: the node records the page in the recent list as it loads.
  const recent = useMemo(() => loadRecent(), [stateUrl])

  // Follow page navigation (a new URL from the server replaces typing that was not submitted).
  useEffect(() => { setDraft(stateUrl); setError(null); setNotice(null) }, [stateUrl])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = resolveOmniboxInput(draft, searchEngine)
    if (!p) return
    if (!p.ok) { setError(URL_ERROR_TEXT[p.reason]); return }
    setError(null)
    nav('go', p.url)
  }

  // Fallback when the node gives no reset: n single steps back to 100% (steps are uniform, browser.zoom.ts).
  const resetZoom = () => {
    if (onZoomReset) { onZoomReset(); return }
    if (!onZoom) return
    const n = Math.round((zoom - 1) / ZOOM_STEP)
    for (let i = 0; i < Math.abs(n); i++) onZoom(n > 0 ? -1 : 1)
  }

  const site = SITE_INFO_TEXT[siteInfoKind(stateUrl)]
  const pct = zoomLabel(zoom)
  const errors = consoleSlot?.errors ?? 0
  const alert = error ?? notice ?? design?.error ?? null
  // Badge while there are errors; also while the drawer is open, so the row still has a way to close it.
  const showConsole = consoleSlot && (errors > 0 || consoleSlot.open)
  const driving = agentControl && state?.lease === 'agent'

  return (
    <div role="toolbar" aria-label={TOOLBAR_TEXT.group} className="browser-toolbar nodrag">
      <div className="browser-toolbar__row">
        <IconButton size="icon-bui" label={TOOLBAR_TEXT.back} tooltip={TIP.back} disabledReason={TIP.backOff} disabled={!state?.canBack} onClick={() => nav('back')}>{icon('arrow-left')}</IconButton>
        <span className="browser-toolbar__forward inline-flex">
          <IconButton size="icon-bui" label={TOOLBAR_TEXT.forward} tooltip={TIP.forward} disabledReason={TIP.forwardOff} disabled={!state?.canForward} onClick={() => nav('forward')}>{icon('arrow-right')}</IconButton>
        </span>
        {state?.loading
          ? <IconButton size="icon-bui" label={TOOLBAR_TEXT.stop} tooltip={TIP.stop} onClick={() => nav('stop')}>{icon('debug-stop')}</IconButton>
          : <IconButton size="icon-bui" label={TOOLBAR_TEXT.reload} tooltip={TIP.reload} onClick={() => nav('reload')}>{icon('refresh')}</IconButton>}
        {/* Every button inside this form is type="button": Enter's implicit submission would otherwise click the
            first one (reset zoom / flip Shields) instead of navigating. */}
        <form className="browser-omnibox" onSubmit={submit}>
          <IconTooltip label={site.tip}>
            <span role="img" tabIndex={0} aria-label={site.label} data-site-info={siteInfoKind(stateUrl)} className={`browser-omnibox__site codicon codicon-${site.icon}`} />
          </IconTooltip>
          <Input
            data-browser-omnibox
            type="text" inputMode="url" spellCheck={false} autoComplete="off" list={listId}
            aria-label={TOOLBAR_TEXT.urlLabel} placeholder={TOOLBAR_TEXT.urlPlaceholder}
            aria-invalid={error !== null} aria-describedby={error ? 'browser-url-error' : undefined}
            className="browser-omnibox__input"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
          />
          <datalist id={listId}>
            {recent.map((r) => <option key={r.url} value={r.url}>{r.title || r.host}</option>)}
          </datalist>
          {onZoom && zoom !== 1 && (
            <span className="browser-omnibox__extra inline-flex">
              <IconButton type="button" size="bui" variant="secondary" className="tabular-nums" label={ZOOM_TEXT.pill(pct)} tooltip={ZOOM_TEXT.pillTip(pct)} onClick={resetZoom}>{pct}</IconButton>
            </span>
          )}
          {onShields && <span className="browser-omnibox__extra inline-flex"><BrowserShieldsChip state={state} onToggle={onShields} /></span>}
        </form>
        {showConsole && (
          <IconButton
            size="bui" variant={consoleSlot.open ? 'secondary' : 'ghost'} aria-pressed={consoleSlot.open} className="browser-toolbar__errors"
            label={errors > 0 ? CONSOLE_TEXT.errors(errors) : CONSOLE_TEXT.toggle} commandId={CONSOLE_COMMAND_ID}
            tooltip={`${errors > 0 ? CONSOLE_TEXT.errors(errors) : CONSOLE_TEXT.toggle}: ${consoleSlot.open ? CONSOLE_TEXT.toggleHintOn : CONSOLE_TEXT.toggleHintOff}`}
            onClick={consoleSlot.toggle}
          >{icon(errors > 0 ? 'error' : 'debug-console')}{errors > 0 && <span className="tabular-nums">{errors}</span>}</IconButton>
        )}
        {/* Agent-control toggle, icon only (the label ate omnibox width): the dot = agents may drive, accent = driving now. */}
        {agentEnabled && (
          <IconButton
            size="icon-bui" variant="ghost" aria-pressed={agentControl} className="browser-toolbar__agent" data-driving={driving || undefined}
            label={TOOLBAR_TEXT.agentPill}
            tooltip={driving ? TOOLBAR_TEXT.agentPillDriving : agentControl ? TOOLBAR_TEXT.agentPillHint : TOOLBAR_TEXT.agentPillHintOff}
            onClick={() => onAgentControl(!agentControl)}
          >{icon('robot')}{agentControl && <span className="browser-toolbar__agent-dot" aria-hidden="true" />}</IconButton>
        )}
        <BrowserToolbarMenu
          state={state} zoom={zoom} onZoom={onZoom} onZoomReset={resetZoom} device={device} onDevice={onDevice} onShields={onShields} design={design}
          agentControl={agentControl} agentEnabled={agentEnabled} onAgentControl={onAgentControl} onEnableAgent={onEnableAgent} console={consoleSlot} onError={setNotice} extraItems={menuItems}
        />
      </div>
      {alert && <p id="browser-url-error" role="alert" className="m-0 px-1 text-xs text-(--vscode-errorForeground)">{alert}</p>}
    </div>
  )
}
