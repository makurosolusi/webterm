// Halaman settings dengan bentuk VS Code Settings editor: search + hitungan hasil di atas, TOC
// section 260px with icon + description (panah/Home/End berpindah fokus), satu pane daftar setting di kanan.
// Below 720px the TOC becomes a section dropdown above full-width content (`NARROW_QUERY`).
// Search reads the static index (./settings.search) and lists "Page › Label" rows; no page mounts while
// searching, and "Go to" opens the page and reveals the field (same path as a cross-link). Dialog tetap
// dipertahankan (full-screen, bukan popover) supaya Escape/focus-trap dan alur buka-tutup yang
// sudah ada tidak berubah; yang berubah hanya chrome dan metriknya — 35px header, 22px baris,
// teks 13px, kontrol 26px, token `--vscode-*`.
//
// Sidebar dikelompokkan (General / Agents / Workspace / System, `group` tiap section); panah/Home/End
// melintasi grup karena navigasi menghitung semua tombol di nav.
//
// Tab Kemampuan (ENVSIMPLE D6) menggantikan Channels dan Environment: tujuh kartu, satu sakelar
// tiap kartu; tautan lama ke `env`/`channels` tetap mendarat di tab ini lewat `toSectionId`.
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
import { AutomationsSection } from './AutomationsSection'
import { DeveloperSection } from './DeveloperSection'
import { HealthSection } from './HealthSection'
import { MemorySection } from './MemorySection'
import { RulesSection } from './RulesSection'
import { SpendingSection } from './SpendingSection'
import { normalizeQuery } from './SettingsFields'
import { searchSettings } from './settings.search'
import { SettingsItemScopeProvider } from './settingsContext'
import { CanvasSection, InteractionSection, ShellSection, TerminalSection } from './SettingsSections'
import { CANVAS_BG_SECTION, CANVAS_BG_WORKSPACE_SECTION, CanvasBackgroundSection } from './CanvasBackgroundSection'
import { toSettingsRouteSection } from './appRoute'
import type { SettingsFieldId } from './settings.link'
import { revealSettingsField } from './settingsPanel.reveal'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'
import { AccountSection } from './AccountSection'
import { SETTINGS_UNDO_TOAST_SLOT, SettingsUndoToast, settingsUndoKeyDown } from './SettingsUndoToast'
import type { SettingsUndo } from './useSettings'
import './settings-sections.css'
import './settings-search.css'

export { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'

/** Section for an id from a link or a saved tab (legacy ids mapped, unknown -> Terminal); lives with the URL whitelist. */
export const toSectionId: (id: string) => SectionId = toSettingsRouteSection

/** What `renderSection` gets: the panel's state and callbacks. */
interface SectionCtx {
  s: Settings
  onChange: (patch: SettingsPatch) => void
  navigate: (to: CentralLinkTarget) => void
  projectId: string
  activeRaw: string
}

/** Section id -> its body. A `Record` over `SectionId`, so a new section without a body fails the type check. */
const SECTION_BODY: Record<SectionId, (c: SectionCtx) => React.JSX.Element> = {
  terminal: (c) => <TerminalSection settings={c.s} onChange={c.onChange} />,
  interaction: (c) => <InteractionSection settings={c.s} onChange={c.onChange} />,
  shell: (c) => <ShellSection settings={c.s} onChange={c.onChange} />,
  agent: (c) => <AgentSettings settings={c.s} onChange={c.onChange} />,
  central: (c) => <CentralSettingsSection settings={c.s} onChange={c.onChange} onNavigate={c.navigate} />,
  rules: () => <RulesSection />,
  memory: () => <MemorySection />,
  automations: () => <AutomationsSection />,
  spending: (c) => <SpendingSection onNavigate={c.navigate} />,
  canvas: (c) => <CanvasSection settings={c.s} onChange={c.onChange} />,
  [CANVAS_BG_SECTION]: (c) => (
    <CanvasBackgroundSection settings={c.s} onChange={c.onChange} projectId={c.projectId || undefined}
      initialScope={c.activeRaw === CANVAS_BG_WORKSPACE_SECTION ? 'workspace' : 'global'} />
  ),
  capabilities: (c) => (
    // Search no longer mounts pages (./settings.search), so the section's own filter always sees ''.
    <CapabilitiesSection projectId={c.projectId} query="" sectionTitle={SETTINGS_SECTIONS.find((x) => x.id === 'capabilities')?.label ?? ''}
      onOpenCentral={() => c.navigate({ section: 'central', field: 'central.central' })} />
  ),
  account: () => <AccountSection />,
  health: () => <HealthSection />,
  developer: () => <DeveloperSection query="" />,
}

interface PanelProps {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
  onClose: () => void
  /** Workspace aktif: proyek tujuan tautan chat Telegram. */
  projectId?: string
  /** Section shown first (e.g. 'central' from the Central card's "Edit launch profile"). */
  initialSection?: string
  /** Controlled section (the URL's `?settings=`); with it, section changes go to `onSectionChange`. */
  section?: string
  /** Setting to reveal in the section (the URL's `&field=`): scrolled to, focused and flashed once it renders. */
  field?: SettingsFieldId
  /** `field` = the setting a cross-link names (undefined = a plain section change, which clears it). */
  onSectionChange?: (id: SectionId, field?: SettingsFieldId) => void
  /** Undo/redo of settings changes (`useSettings().history`): toast + ⌘Z/⇧⌘Z while the panel has focus. */
  history?: SettingsUndo
}

/** Below this width the sidebar becomes a section dropdown (no room for a 260px column next to the fields). */
export const NARROW_QUERY = '(max-width: 719px)'

/** True while the viewport matches `NARROW_QUERY`; follows resizes. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY)
    if (!mq) return undefined
    const sync = (): void => setNarrow(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return narrow
}

const sectionLabel = (id: SectionId): string => SETTINGS_SECTIONS.find((x) => x.id === id)?.label ?? id

/** Dialog Settings. */
export function SettingsPanel({ settings: s, onChange, onClose, projectId = '', history, initialSection = 'terminal', section, field, onSectionChange }: PanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalized = useMemo(() => normalizeQuery(query), [query])
  const [ownRaw, setOwnRaw] = useState<string>(initialSection)
  const activeRaw = section ?? ownRaw
  const setActive = (id: string, to?: SettingsFieldId): void => { setOwnRaw(id); onSectionChange?.(toSectionId(id), to) }
  const active = toSectionId(activeRaw)
  const results = useMemo(() => searchSettings(normalized), [normalized])
  const found = results.reduce((n, g) => n + g.entries.length, 0)
  const narrow = useNarrow()
  const mainRef = useRef<HTMLElement>(null)
  // A link from one section into another (Central Agent -> Agent › Models): switch and reveal its field.
  // Uncontrolled (no `section` prop) the panel keeps the field itself; controlled it comes back as `field`.
  const [ownField, setOwnField] = useState<SettingsFieldId | undefined>()
  const target = section === undefined ? ownField : field
  // One way to open a page: TOC click (no field), cross-link, search result "Go to".
  const open = (id: string, to?: SettingsFieldId): void => {
    setQuery('')
    setOwnField(to)
    setActive(id, to)
  }
  const navigate = (to: CentralLinkTarget): void => open(to.section, to.field)

  // Pindah section = daftar baru, mulai dari atas seperti VS Code saat memilih entri TOC.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [active, normalized])

  // Reveal the linked setting once its section has rendered it (after this effect's scrollTop reset).
  // `normalized`: leaving search remounts the page, so the same target from a result reveals again.
  useEffect(() => (target && !normalized ? revealSettingsField(() => mainRef.current, target) : undefined), [target, active, normalized])

  const renderSection = (id: SectionId): React.JSX.Element =>
    SECTION_BODY[id]({ s, onChange, navigate, projectId, activeRaw })

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
          // Radix listens in the capture phase, before the focused control sees the key: any element that
          // handles Escape itself (inline editor, open combobox list) is marked data-settings-escape.
          if (event.defaultPrevented || (event.target as Element | null)?.closest?.('[data-settings-escape]')) {
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
              {found ? (
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

          <div className={'st-body' + (narrow ? ' is-narrow' : '')}>
            {narrow ? (
              <div className="st-section-picker">
                <span className="st-select-wrap">
                  <select className="st-select" aria-label="Settings section" value={active} onChange={(event) => open(event.target.value)}>
                    {SETTINGS_GROUPS.map((group) => (
                      <optgroup key={group} label={group}>
                        {SETTINGS_SECTIONS.filter((section) => section.group === group).map((section) => (
                          <option key={section.id} value={section.id}>{section.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <span className="codicon codicon-chevron-down st-select-chevron" aria-hidden="true" />
                </span>
              </div>
            ) : (
              <nav className="st-sidebar" aria-label="Section settings" onKeyDown={onTocKeyDown}>
                {SETTINGS_GROUPS.map((group) => (
                  <div key={group} role="group" className="st-nav-group" aria-labelledby={`st-nav-group-${group}`}>
                    <div id={`st-nav-group-${group}`} className="st-nav-group-title">{group}</div>
                    {SETTINGS_SECTIONS.filter((section) => section.group === group).map((section) => (
                      <button
                        key={section.id}
                        type="button"
                        aria-current={active === section.id && !normalized}
                        className={'st-nav' + (active === section.id && !normalized ? ' is-active' : '')}
                        // Name = title only (aria-labelledby), the description is read as the item's description.
                        aria-labelledby={`st-nav-${section.id}`}
                        aria-describedby={`st-nav-${section.id}-desc`}
                        onClick={() => open(section.id)}
                      >
                        <span className={`codicon codicon-${section.icon} st-nav-icon`} aria-hidden="true" />
                        <span className="st-nav-text">
                          <span id={`st-nav-${section.id}`} className="st-nav-label">{section.label}</span>
                          <span id={`st-nav-${section.id}-desc`} className="st-nav-desc">{section.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
            )}

            <main className="st-main" aria-label="Settings" ref={mainRef}>
              {normalized ? (
                results.length ? results.map(({ page, entries }) => (
                  <section key={page} className="st-search-group" aria-labelledby={`st-group-${page}`}>
                    <h3 id={`st-group-${page}`} className="st-group-title">{sectionLabel(page)}</h3>
                    <ul className="st-results">
                      {entries.map((entry) => (
                        <li key={entry.field ?? `${page}:${entry.label}`} className="st-result">
                          <button type="button" className="st-result-go" onClick={() => open(entry.page, entry.field)}>
                            {entry.label === sectionLabel(page) ? entry.label : <><span className="st-result-path">{sectionLabel(page)} ›</span> {entry.label}</>}
                          </button>
                          {entry.hint ? <p className="st-hint">{entry.hint}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                )) : (
                  <p className="st-no-results" role="status">No settings match “{query.trim()}”.</p>
                )
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
          </div>
        </div>
        <SettingsUndoToast history={history} />
      </DialogContent>
    </Dialog>
  )
}
