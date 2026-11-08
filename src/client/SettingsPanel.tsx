// Halaman settings dengan bentuk VS Code Settings editor: search + hitungan hasil di atas, TOC
// section 260px with icon + description (panah/Home/End berpindah fokus), satu pane daftar setting di kanan. Dialog tetap
// dipertahankan (full-screen, bukan popover) supaya Escape/focus-trap dan alur buka-tutup yang
// sudah ada tidak berubah; yang berubah hanya chrome dan metriknya — 35px header, 22px baris,
// teks 13px, kontrol 26px, token `--vscode-*`.
//
// Pengelompokan section mengikuti komentar grup di `shared/settings.ts` supaya skema dan UI tidak
// bisa berbeda pendapat.
//
// Tab Kemampuan (ENVSIMPLE D6) menggantikan Channels dan Environment: tujuh kartu, satu sakelar
// tiap kartu. Pencarian di sana hanya mencocokkan judul bagian dan judul kartu; tautan lama ke
// `env`/`channels` tetap mendarat di tab ini lewat `toSectionId`.
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
import { IconTooltip } from '@/components/ui/icon-button'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { AgentSettings } from './SettingsAgents'
import { CapabilitiesSection } from './CapabilitiesSection'
import { CentralSettingsSection } from './CentralSettingsSection'
import type { CentralLinkTarget } from './centralSettings.registry'
import { ControlPanel } from './ControlPanel'
import { SettingsSearchProvider, normalizeQuery } from './SettingsFields'
import { SettingsItemScopeProvider } from './settingsContext'
import { CanvasSection, InteractionSection, ShellSection, TerminalSection } from './SettingsSections'
import { CANVAS_BG_SECTION, CANVAS_BG_WORKSPACE_SECTION, CanvasBackgroundSection } from './CanvasBackgroundSection'
import { SETTINGS_UNDO_TOAST_SLOT, SettingsUndoToast, settingsUndoKeyDown } from './SettingsUndoToast'
import type { SettingsUndo } from './useSettings'

/** Settings sections: nav entry + page header, one place. `icon` is a codicon name; `description` says what is inside. */
export const SETTINGS_SECTIONS = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal', description: 'Font, colors, cursor, scrollback' },
  { id: 'interaction', label: 'Interaction', icon: 'keyboard', description: 'Copy & paste, shortcuts, selection' },
  { id: 'shell', label: 'Shell & buffer', icon: 'server-process', description: 'Which shell to start, replay buffer' },
  { id: 'agent', label: 'Agent', icon: 'hubot', description: 'Permissions, custom agents, profiles' },
  { id: 'central', label: 'Central Agent', icon: 'comment-discussion', description: 'Autonomy, spending, abilities' },
  { id: 'canvas', label: 'Canvas', icon: 'layout', description: 'Grid, new node size, search engine' },
  { id: CANVAS_BG_SECTION, label: 'Canvas background', icon: 'paintcan', description: 'Color, gradient or image behind nodes' },
  { id: 'capabilities', label: 'Capabilities', icon: 'extensions', description: 'Turn features on or off' },
  { id: 'control', label: 'Control', icon: 'tools', description: 'Every value and source, policies, costs' },
] as const

type SectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** Id tab lama `env`/`channels` mendarat di Kemampuan; id tak dikenal (mis. `preview` warisan) jatuh ke Terminal. */
export function toSectionId(id: string): SectionId {
  if (id === 'env' || id === 'channels') return 'capabilities'
  if (id === CANVAS_BG_WORKSPACE_SECTION) return CANVAS_BG_SECTION
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.id ?? 'terminal'
}

interface PanelProps {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
  onClose: () => void
  /** Workspace aktif: proyek tujuan tautan chat Telegram. */
  projectId?: string
  /** Section shown first (e.g. 'central' from the Central card's "Edit launch profile"). */
  initialSection?: string
  /** Undo/redo of settings changes (`useSettings().history`): toast + ⌘Z/⇧⌘Z while the panel has focus. */
  history?: SettingsUndo
}

/** Dialog Settings. */
export function SettingsPanel({ settings: s, onChange, onClose, projectId = '', history, initialSection = 'terminal' }: PanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalized = useMemo(() => normalizeQuery(query), [query])
  const [activeRaw, setActive] = useState<string>(initialSection)
  const active = toSectionId(activeRaw)
  const [found, setFound] = useState(0)
  const [capabilityHits, setCapabilityHits] = useState(0)
  const mainRef = useRef<HTMLElement>(null)
  // A link from one section into another (Central Agent -> Agent › Models): switch, then scroll to the anchor.
  const [anchor, setAnchor] = useState<string | undefined>()
  const navigate = (to: CentralLinkTarget): void => {
    setQuery('')
    setActive(to.section)
    setAnchor(to.anchor)
  }

  // Hitungan "N setting ditemukan": Field dibaca dari DOM (menyaring dirinya sendiri, jadi tak bisa
  // berbeda dari layar) + kartu Kemampuan yang cocok, dilaporkan bagiannya sendiri.
  useEffect(() => {
    const fields = mainRef.current?.querySelectorAll('[data-slot="settings-field"]').length ?? 0
    setFound(normalized ? fields + capabilityHits : 0)
  }, [normalized, s, capabilityHits])

  // Pindah section = daftar baru, mulai dari atas seperti VS Code saat memilih entri TOC.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [active, normalized])

  // The anchor may render after an async load (capability cards): retry for a moment, then give up.
  useEffect(() => {
    if (!anchor) return
    let tries = 0
    const timer = window.setInterval(() => {
      const el = mainRef.current?.querySelector<HTMLElement>(anchor)
      if (el || ++tries > 20) {
        el?.scrollIntoView?.({ block: 'start' })
        window.clearInterval(timer)
        setAnchor(undefined)
      }
    }, 50)
    return () => window.clearInterval(timer)
  }, [anchor, active])

  const renderSection = (id: SectionId): React.JSX.Element => {
    if (id === 'terminal') return <TerminalSection settings={s} onChange={onChange} />
    if (id === 'interaction') return <InteractionSection settings={s} onChange={onChange} />
    if (id === 'shell') return <ShellSection settings={s} onChange={onChange} />
    if (id === 'agent') return <AgentSettings settings={s} onChange={onChange} />
    if (id === 'central') return <CentralSettingsSection settings={s} onChange={onChange} onNavigate={navigate} />
    if (id === 'canvas') return <CanvasSection settings={s} onChange={onChange} />
    if (id === CANVAS_BG_SECTION) {
      return <CanvasBackgroundSection settings={s} onChange={onChange} projectId={projectId || undefined}
        initialScope={activeRaw === CANVAS_BG_WORKSPACE_SECTION ? 'workspace' : 'global'} />
    }
    if (id === 'control') return <ControlPanel query={normalized} />
    return (
      <CapabilitiesSection projectId={projectId} query={normalized} sectionTitle={SETTINGS_SECTIONS.find((x) => x.id === 'capabilities')?.label ?? ''}
        onVisibleCount={setCapabilityHits} onSettingsChange={onChange} onOpenCentral={() => navigate({ section: 'central' })} />
    )
  }

  const activeSection = SETTINGS_SECTIONS.find((section) => section.id === active) ?? SETTINGS_SECTIONS[0]
  const activeLabel = activeSection.label

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
        // inset-0 + translate-*-0 replace the shadcn centering utilities (tailwind-merge) so the page fills the viewport.
        className="st-dialog-content inset-0 translate-x-0 translate-y-0"
        showCloseButton={false}
        onKeyDown={settingsUndoKeyDown(history)}
        // The Undo toast is portaled outside the dialog; clicking it must not count as "outside".
        onInteractOutside={(event) => {
          if ((event.target as Element | null)?.closest?.(`[data-slot="${SETTINGS_UNDO_TOAST_SLOT}"]`)) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          // An inline editor marked data-settings-escape handles Escape itself (cancel), so the dialog stays open.
          if ((event.target as Element | null)?.closest?.('[data-settings-escape]')) {
            event.preventDefault()
            return
          }
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
            <IconTooltip label="Close settings" shortcut="Esc">
              <button
                type="button"
                className="st-close"
                aria-label="Close settings"
                onClick={onClose}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </IconTooltip>
          </header>

          <div className="st-searchbar">
            <div className="st-search-wrap">
              <span className="codicon codicon-search st-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="st-search"
                aria-label="Search settings"
                placeholder="Search settings"
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
              {normalized ? (
                <span className="st-search-count" role="status">{found} {found === 1 ? 'setting' : 'settings'} found</span>
              ) : null}
              {query ? (
                <IconTooltip label="Clear Search Results">
                  <button
                    type="button"
                    className="st-search-clear"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                  >
                    <span className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </IconTooltip>
              ) : null}
            </div>
          </div>

          <div className="st-body">
            <nav className="st-sidebar" aria-label="Section settings" onKeyDown={onTocKeyDown}>
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  aria-current={active === section.id && !normalized}
                  className={'st-nav' + (active === section.id && !normalized ? ' is-active' : '')}
                  // Name = title only (aria-labelledby), the description is read as the item's description.
                  aria-labelledby={`st-nav-${section.id}`}
                  aria-describedby={`st-nav-${section.id}-desc`}
                  onClick={() => {
                    setActive(section.id)
                    setQuery('')
                  }}
                >
                  <span className={`codicon codicon-${section.icon} st-nav-icon`} aria-hidden="true" />
                  <span className="st-nav-text">
                    <span id={`st-nav-${section.id}`} className="st-nav-label">{section.label}</span>
                    <span id={`st-nav-${section.id}-desc`} className="st-nav-desc">{section.description}</span>
                  </span>
                </button>
              ))}
            </nav>

            <SettingsSearchProvider query={normalized}>
              <main className="st-main" aria-label="Settings" ref={mainRef}>
                {normalized ? (
                  <>
                    {SETTINGS_SECTIONS.map((section) => (
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
                      No settings match “{query.trim()}”.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="st-section-head">
                      <h2 className="st-section-title">
                        <span className={`codicon codicon-${activeSection.icon}`} aria-hidden="true" />
                        {activeLabel}
                      </h2>
                      <p className="st-section-desc">{activeSection.description}</p>
                    </div>
                    <SettingsItemScopeProvider category={activeLabel} settings={s} onChange={onChange}>
                      {renderSection(active)}
                    </SettingsItemScopeProvider>
                  </>
                )}
              </main>
            </SettingsSearchProvider>
          </div>
        </div>
        <SettingsUndoToast history={history} />
      </DialogContent>
    </Dialog>
  )
}
