// Halaman settings dengan bentuk VS Code Settings editor: search + hitungan hasil di atas, TOC
// section 200px (panah/Home/End berpindah fokus), satu pane daftar setting di kanan. Dialog tetap
// dipertahankan (full-screen, bukan popover) supaya Escape/focus-trap dan alur buka-tutup yang
// sudah ada tidak berubah; yang berubah hanya chrome dan metriknya — 35px header, 22px baris,
// teks 13px, kontrol 26px, token `--vscode-*`.
//
// Pengelompokan section mengikuti komentar grup di `shared/settings.ts` supaya skema dan UI tidak
// bisa berbeda pendapat.
//
// Pencarian lintas Environment: `EnvSettingsProvider` (state + draft) dipasang DI ATAS view dan tak
// pernah di-remount saat query berubah, jadi mengetik di pencarian tidak membuang draft. Baris env
// dihitung dari state (bukan DOM) supaya baris tersembunyi/akordeon tertutup tetap terhitung; entri
// milik Channels tak punya baris di Environment dan tampil sebagai tautan ke tab Channels.
//
// Props-driven: `settings` + `onChange` masuk sebagai prop, integrator yang me-mount dan
// menyambungkannya ke `useSettings()`.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Settings } from '../shared/settings'
import { AgentSettings } from './SettingsAgents'
import { ChannelsSection } from './ChannelsSection'
import { EnvSection } from './EnvSection'
import { SettingsSearchProvider, normalizeQuery } from './SettingsFields'
import { ENV_KEY_ATTR, matchesEntry } from './envSearch'
import { EnvSettingsProvider, useEnvSettingsContext } from './useEnvSettings'
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import { SettingsItemScopeProvider } from './settingsContext'
import { CanvasSection, InteractionSection, ShellSection, TerminalSection } from './SettingsSections'
import './settings.css'
import './settings-controls.css'

const SECTIONS = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'interaction', label: 'Interaksi' },
  { id: 'shell', label: 'Shell & buffer' },
  { id: 'agent', label: 'Agent' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'channels', label: 'Channels' },
  { id: 'env', label: 'Environment' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Id tab tak dikenal (mis. `preview` warisan, sudah dilebur ke Terminal/Interaksi) jatuh ke Terminal. */
export function toSectionId(id: string): SectionId {
  return SECTIONS.find((section) => section.id === id)?.id ?? 'terminal'
}

const OWNER_CHANNELS = 'channels'
const IN_CHANNELS_TAB = 'ada di tab Channels'

interface PanelProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

/** Entri Channels yang cocok query: tautan ke tab pemiliknya (tanpa baris env di Environment). */
function ChannelsHits({ hits, onOpen }: { hits: EnvEntryV2[]; onOpen: () => void }): React.JSX.Element | null {
  if (hits.length === 0) return null
  return (
    <ul className="st-ch-list">
      {hits.map((entry) => (
        <li key={entry.key} className="st-field" data-env-hit={entry.key}>
          <div className="st-title">
            <span className="st-label">{entry.label}</span> <code className="st-mono">{entry.key}</code>
          </div>
          <button type="button" className="st-button" onClick={onOpen}>{IN_CHANNELS_TAB}</button>
        </li>
      ))}
    </ul>
  )
}

/** Dialog Settings; provider env ada di luar view agar draft selamat dari perubahan query. */
export function SettingsPanel(props: PanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalized = useMemo(() => normalizeQuery(query), [query])
  return (
    <EnvSettingsProvider query={normalized}>
      <SettingsPanelView {...props} query={query} setQuery={setQuery} normalized={normalized} />
    </EnvSettingsProvider>
  )
}

function SettingsPanelView({
  settings: s,
  onChange,
  onClose,
  query,
  setQuery,
  normalized,
}: PanelProps & { query: string; setQuery: (q: string) => void; normalized: string }): React.JSX.Element {
  const [activeRaw, setActive] = useState<string>('terminal')
  const active = toSectionId(activeRaw)
  const [found, setFound] = useState(0)
  const [channelsFocus, setChannelsFocus] = useState<string>()
  const mainRef = useRef<HTMLElement>(null)
  const entries = useEnvSettingsContext().state?.entries
  const envHits = useMemo(
    () => (normalized && entries ? entries.filter((entry) => matchesEntry(entry, normalized)) : []),
    [normalized, entries],
  )
  const channelHits = useMemo(() => envHits.filter((entry) => entry.owner === OWNER_CHANNELS), [envHits])

  // Hitungan "N setting ditemukan": Field non-env dibaca dari DOM (menyaring dirinya sendiri, jadi
  // tak bisa berbeda dari layar) + entri env yang cocok dari state, termasuk milik Channels.
  useEffect(() => {
    const fields = mainRef.current?.querySelectorAll(`[data-slot="settings-field"]:not([${ENV_KEY_ATTR}])`).length ?? 0
    setFound(normalized ? fields + envHits.length : 0)
  }, [normalized, s, envHits])

  // Pindah section = daftar baru, mulai dari atas seperti VS Code saat memilih entri TOC.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [active, normalized])

  const renderSection = (id: SectionId): React.JSX.Element => {
    if (id === 'terminal') return <TerminalSection settings={s} onChange={onChange} />
    if (id === 'interaction') return <InteractionSection settings={s} onChange={onChange} />
    if (id === 'shell') return <ShellSection settings={s} onChange={onChange} />
    if (id === 'agent') return <AgentSettings settings={s} onChange={onChange} />
    if (id === 'canvas') return <CanvasSection settings={s} onChange={onChange} />
    if (id === 'channels') {
      return (
        <>
          <ChannelsSection focusKey={channelsFocus} onFocused={() => setChannelsFocus(undefined)} />
          <ChannelsHits hits={channelHits} onOpen={() => { setActive('channels'); setQuery('') }} />
        </>
      )
    }
    return <EnvSection onOpenChannels={(key) => { setActive('channels'); setChannelsFocus(key) }} />
  }

  const activeLabel = SECTIONS.find((section) => section.id === active)?.label ?? 'Settings'

  // Roving fokus ala tree VS Code: panah/Home/End memindah fokus, Enter/Space memilih.
  const onTocKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="st-dialog-content"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          // Escape mengosongkan pencarian dulu; baru Escape kedua menutup dialog.
          if (query) {
            event.preventDefault()
            setQuery('')
          }
        }}
      >
        <DialogTitle className="st-sr-only">Settings</DialogTitle>
        <DialogDescription className="st-sr-only">Configure webterm behavior and appearance.</DialogDescription>
        <div className="st-editor">
          <header className="st-header">
            <span className="st-header-title">Settings</span>
            <button
              type="button"
              className="st-close"
              aria-label="Tutup settings"
              onClick={onClose}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </header>

          <div className="st-searchbar">
            <div className="st-search-wrap">
              <span className="codicon codicon-search st-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="st-search"
                aria-label="Cari setting"
                placeholder="Cari setting"
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
              {normalized ? (
                <span className="st-search-count" role="status">{found} setting ditemukan</span>
              ) : null}
              {query ? (
                <button
                  type="button"
                  className="st-search-clear"
                  aria-label="Hapus pencarian"
                  title="Clear Search Results"
                  onClick={() => setQuery('')}
                >
                  <span className="codicon codicon-close" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="st-body">
            <nav className="st-sidebar" aria-label="Section settings" onKeyDown={onTocKeyDown}>
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  aria-current={active === section.id && !normalized}
                  className={'st-nav' + (active === section.id && !normalized ? ' is-active' : '')}
                  onClick={() => {
                    setActive(section.id)
                    setQuery('')
                  }}
                >
                  {section.label}
                </button>
              ))}
            </nav>

            <SettingsSearchProvider query={normalized}>
              <main className="st-main" aria-label="Settings" ref={mainRef}>
                {normalized ? (
                  <>
                    {SECTIONS.map((section) => (
                      <section
                        key={section.id}
                        className="st-search-group"
                        aria-labelledby={`st-group-${section.id}`}
                      >
                        <h3 id={`st-group-${section.id}`} className="st-group-title">
                          {section.label}
                        </h3>
                        <SettingsItemScopeProvider category={section.label} settings={s} onChange={onChange}>
                          {renderSection(section.id)}
                        </SettingsItemScopeProvider>
                      </section>
                    ))}
                    <p className="st-no-results" role="status">
                      Tidak ada setting yang cocok dengan “{query.trim()}”.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="st-section-title">{activeLabel}</h2>
                    <SettingsItemScopeProvider category={activeLabel} settings={s} onChange={onChange}>
                      {renderSection(active)}
                    </SettingsItemScopeProvider>
                  </>
                )}
              </main>
            </SettingsSearchProvider>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
