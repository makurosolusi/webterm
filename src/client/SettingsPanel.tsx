// Settings as a full-screen page in the macOS System Settings / Linear shape: a sidebar (search box on
// top, single-line items under group headings) and a centred content column of grouped rows. Below
// `NARROW_QUERY` the sidebar becomes the search box over a section dropdown above the content.
// Search reads the static index (./settings.search) and lists "Page › Label" rows; no page mounts while
// searching, and a result opens the page and reveals the field (same path as a cross-link). ⌘F or `/`
// focuses the search box, Enter opens the first result, ArrowDown moves into the results. Kept as a
// Dialog (full-screen, not a popover) so Escape, the focus trap and open/close stay as they were.
//
// Developer only shows in developer mode (./developerMode); a link still opens it. Memory, Automations
// and Spending moved to the Control panel: their search results open that tab (`go`).
// Features (id `capabilities`) replaces Channels and Environment; old `env`/`channels` links land there
// through `toSectionId`. A link that names a field opens the page holding it (`pageOfField`).
//
// Props-driven: `settings` + `onChange` come in as props; the integrator wires them to `useSettings()`.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { IconTooltip } from '@/components/ui/icon-button'
import { ClaudeSettingsSection } from './ClaudeSettingsSection'
import { CapabilitiesSection } from './CapabilitiesSection'
import { CentralSettingsSection } from './CentralSettingsSection'
import type { CentralLinkTarget } from './centralSettings.registry'
import { DeveloperSection } from './DeveloperSection'
import { HealthSection } from './HealthSection'
import { KeybindingsSection } from './SettingsKeybindings'
import { RulesSection } from './RulesSection'
import { normalizeQuery } from './SettingsFieldRow'
import { SETTINGS_SEARCH_INDEX, searchSettings, type SearchGroupId, type SettingsSearchEntry } from './settings.search'
import { openCentralTab } from './secondarySideBar.store'
import { SettingsItemScopeProvider } from './settingsContext'
import { AppearanceSection, CanvasSection, TerminalSection } from './SettingsSections'
import { NotificationsSection } from './osNotify.settings'
import { useDeveloperMode } from './developerMode'
import { toSettingsRouteSection } from './appRoute'
import type { SettingsFieldId } from './settings.link'
import { revealSettingsField } from './settingsPanel.reveal'
import { MOVED_GROUP_LABEL, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'
import { AccountSection } from './AccountSection'
import { SETTINGS_UNDO_TOAST_SLOT, SettingsUndoToast, settingsUndoKeyDown } from './SettingsUndoToast'
import { NARROW_QUERY, SettingsNavList, SettingsSearchBox, SettingsSectionPicker } from './SettingsNav'
import { focusFirstResult, SettingsSearchResults } from './SettingsSearchResults'
import { SettingsPageHeader } from './SettingsPageHeader'
import type { SettingsUndo } from './useSettings'
import type { WorkspaceName } from './RulesSection'
import './settings-sections.css'
import './settings-search.css'

export { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'
export { NARROW_QUERY } from './SettingsNav'

/** Section for an id from a link or a saved tab (legacy ids mapped, unknown -> Appearance); lives with the URL whitelist. */
export const toSectionId: (id: string) => SectionId = toSettingsRouteSection

/** What `renderSection` gets: the panel's state and callbacks. */
interface SectionCtx {
  s: Settings
  onChange: (patch: SettingsPatch) => void
  navigate: (to: CentralLinkTarget) => void
  projectId: string
  workspaces: readonly WorkspaceName[]
}

/** Section id -> its body. A `Record` over `SectionId`, so a new section without a body fails the type check. */
const SECTION_BODY: Record<SectionId, (c: SectionCtx) => React.JSX.Element> = {
  appearance: (c) => <AppearanceSection settings={c.s} onChange={c.onChange} projectId={c.projectId || undefined} />,
  terminal: (c) => <TerminalSection settings={c.s} onChange={c.onChange} />,
  keyboard: () => <KeybindingsSection />,
  canvas: (c) => <CanvasSection settings={c.s} onChange={c.onChange} />,
  notifications: () => <NotificationsSection />,
  claude: (c) => <ClaudeSettingsSection settings={c.s} onChange={c.onChange} projectId={c.projectId || undefined} />,
  central: (c) => <CentralSettingsSection settings={c.s} onChange={c.onChange} onNavigate={c.navigate} />,
  rules: (c) => <RulesSection workspaceId={c.projectId} workspaces={c.workspaces} />,
  capabilities: (c) => <CapabilitiesSection projectId={c.projectId} settings={c.s} onChange={c.onChange} />,
  account: () => <AccountSection />,
  health: () => <HealthSection />,
  developer: () => <DeveloperSection />,
}

interface PanelProps {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
  onClose: () => void
  /** Workspace aktif: proyek tujuan tautan chat Telegram. */
  projectId?: string
  /** Every workspace's id and name: Rules & secrets names the workspace a rule is limited to. */
  workspaces?: readonly WorkspaceName[]
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

const NO_WORKSPACES: readonly WorkspaceName[] = []

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

const sectionLabel = (id: SearchGroupId): string => (id === 'control' ? MOVED_GROUP_LABEL : SETTINGS_SECTIONS.find((x) => x.id === id)?.label ?? id)

/** The page that holds `field` (from the search index), so a link with an old section id still lands. */
export const pageOfField = (field: SettingsFieldId | undefined): SectionId | undefined => {
  const page = field ? SETTINGS_SEARCH_INDEX.find((x) => x.field === field)?.page : undefined
  return page === 'control' ? undefined : page
}

/** Dialog Settings. */
export function SettingsPanel({ settings: s, onChange, onClose, projectId = '', workspaces = NO_WORKSPACES, history, initialSection = 'appearance', section, field, onSectionChange }: PanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalized = useMemo(() => normalizeQuery(query), [query])
  const [ownRaw, setOwnRaw] = useState<string>(initialSection)
  const activeRaw = section ?? ownRaw
  const setActive = (id: string, to?: SettingsFieldId): void => { setOwnRaw(id); onSectionChange?.(toSectionId(id), to) }
  const developer = useDeveloperMode()
  const shown = (id: SectionId): boolean => id !== 'developer' || developer
  const results = useMemo(() => searchSettings(normalized).filter((g) => g.page !== 'developer' || developer), [normalized, developer])
  const narrow = useNarrow()
  const mainRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // A link from one section into another (Central Agent -> Agent › Models): switch and reveal its field.
  // Uncontrolled (no `section` prop) the panel keeps the field itself; controlled it comes back as `field`.
  const [ownField, setOwnField] = useState<SettingsFieldId | undefined>()
  const target = section === undefined ? ownField : field
  const active = pageOfField(target) ?? toSectionId(activeRaw)
  // One way to open a page: TOC click (no field), cross-link, search result "Go to".
  const open = (id: string, to?: SettingsFieldId): void => {
    setQuery('')
    setOwnField(to)
    setActive(id, to)
  }
  const navigate = (to: CentralLinkTarget): void => open(to.section, to.field)
  // A result that moved out of Settings (Memory, Automations, Spending) opens its Control side bar tab instead.
  const go = (entry: SettingsSearchEntry): void => {
    if (entry.ctab) { onClose(); openCentralTab(entry.ctab); return }
    open(entry.page, entry.field)
  }

  // A new page starts at the top, as VS Code does when a TOC entry is picked.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [active, normalized])

  // Reveal the linked setting once its section has rendered it (after this effect's scrollTop reset).
  // `normalized`: leaving search remounts the page, so the same target from a result reveals again.
  useEffect(() => (target && !normalized ? revealSettingsField(() => mainRef.current, target) : undefined), [target, active, normalized])

  const renderSection = (id: SectionId): React.JSX.Element =>
    SECTION_BODY[id]({ s, onChange, navigate, projectId, workspaces })

  const activeSection = SETTINGS_SECTIONS.find((section) => section.id === active) ?? SETTINGS_SECTIONS[0]
  const undoKeys = settingsUndoKeyDown(history)
  // ⌘F / Ctrl+F anywhere in Settings, or `/` outside a text field, focuses search (Linear, GitHub).
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const typing = (event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable="true"]')
    if (((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') || (event.key === '/' && !typing)) {
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    undoKeys(event)
  }
  const first = results[0]?.entries[0]
  const searchBox = (
    <SettingsSearchBox ref={searchRef} query={query} onQuery={setQuery}
      onEnter={() => { if (first) go(first) }} onDown={() => focusFirstResult(mainRef.current)} />
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        // inset-0 + translate-*-0 replace the shadcn centering utilities (tailwind-merge) so the page fills the viewport.
        className="st-dialog-content inset-0 translate-x-0 translate-y-0"
        showCloseButton={false}
        onKeyDown={onKeyDown}
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
          // Escape clears the search first; a second Escape closes the dialog.
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
              <button type="button" className="st-close" aria-label="Close settings" onClick={onClose}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </IconTooltip>
          </header>

          <div className={'st-body' + (narrow ? ' is-narrow' : '')}>
            {narrow ? (
              <div className="st-section-picker">
                {searchBox}
                <SettingsSectionPicker active={active} shown={shown} onOpen={(id) => open(id)} />
              </div>
            ) : (
              <aside className="st-sidebar">
                <div className="st-sidebar-search">{searchBox}</div>
                <SettingsNavList active={active} searching={!!normalized} shown={shown} onOpen={(id) => open(id)} />
              </aside>
            )}

            <main className="st-main" aria-label="Settings" ref={mainRef}>
              <div className="st-content">
                {normalized ? (
                  <SettingsSearchResults query={query} normalized={normalized} results={results} labelOf={sectionLabel} onGo={go} />
                ) : (
                  <>
                    <SettingsPageHeader section={activeSection} settings={s} onChange={onChange} />
                    <div className="st-page" data-page={active}>
                      <SettingsItemScopeProvider category={activeSection.label} settings={s} onChange={onChange}>
                        {renderSection(active)}
                      </SettingsItemScopeProvider>
                    </div>
                  </>
                )}
              </div>
            </main>
          </div>
        </div>
        <SettingsUndoToast history={history} />
      </DialogContent>
    </Dialog>
  )
}
