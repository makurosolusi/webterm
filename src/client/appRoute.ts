// The desktop client's URL contract: which board is open (`/w/:workspaceId`) plus the overlays shown
// on top of it as search params, so a reload (or a shared link) lands on the same screen:
//   ?settings=<section>[&field=<setting>]  ?ctab=<Central tab>  ?panel=<bottom panel view>  ?view=kanban  ?help=1
//   ?setup=1 (first-run wizard, resume) | ?setup=<step>
// The canvas stays mounted under every overlay. Values outside the whitelists below are dropped.
// Opening an overlay pushes a history entry (Back closes it, like VS Code web / GitHub modals);
// changes inside an open overlay and closing it replace the entry.
import { useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router'
import { CENTRAL_PANEL_TABS } from './central/centralTabs'
import { SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'
import { SETUP_STEPS, type SetupStep } from '../shared/settings.setup'
import { toSettingsFieldId, type SettingsFieldId } from './settings.link'

/** `?settings=` values: the ids of `SETTINGS_SECTIONS`, read from the React-free registry so the lazily
 *  loaded Settings panel stays out of the start-up chunk. */
export const SETTINGS_ROUTE_SECTIONS: readonly SectionId[] = SETTINGS_SECTIONS.map((s) => s.id)
/** Retired ids and where they land now: `env`/`channels` -> Features, the old Control mega page -> Health,
 *  Interaction and Shell & buffer -> Terminal, Canvas background (global or `:workspace`) -> Appearance.
 *  A link that also names a field lands on the page holding that field (SettingsPanel `pageOfField`). */
const LEGACY_SETTINGS_SECTION: Readonly<Record<string, SettingsRouteSection>> = {
  env: 'capabilities', channels: 'capabilities', control: 'health',
  interaction: 'terminal', shell: 'terminal', background: 'appearance', 'background:workspace': 'appearance', 'canvas-background': 'appearance',
}

/** Section for an id from a link, an event or a saved tab; unknown ids (e.g. legacy `preview`) fall back to Appearance (the first page). */
export function toSettingsRouteSection(id: string): SettingsRouteSection {
  return LEGACY_SETTINGS_SECTION[id] ?? pick(SETTINGS_ROUTE_SECTIONS, id) ?? 'appearance'
}

/** `?ctab=` values: the tabs of the Central control panel (same list the panel renders). */
export const CENTRAL_ROUTE_TABS = CENTRAL_PANEL_TABS
/** `?panel=` values: the views of the bottom panel (`App.bottomPanel`). */
export const BOTTOM_PANEL_ROUTE_IDS = ['problems', 'activity', 'output', 'tasks'] as const
/** `?view=` values: full-screen views over the board. */
export const APP_ROUTE_VIEWS = ['kanban'] as const

export type SettingsRouteSection = SectionId
export type CentralRouteTab = (typeof CENTRAL_ROUTE_TABS)[number]
export type BottomPanelRouteId = (typeof BOTTOM_PANEL_ROUTE_IDS)[number]
export type AppRouteView = (typeof APP_ROUTE_VIEWS)[number]
/** `?setup=` value: a wizard step, or `resume` (`?setup=1`) = the first unfinished step. */
export type SetupRoute = SetupStep | 'resume'

/** Everything the URL says about the screen. */
export interface AppRoute {
  workspaceId: string | null
  settings: SettingsRouteSection | null
  /** The setting revealed in the open section (`&field=`); only with `settings`, cleared by any other section change. */
  field: SettingsFieldId | null
  ctab: CentralRouteTab | null
  panel: BottomPanelRouteId | null
  view: AppRouteView | null
  help: boolean
  setup: SetupRoute | null
}

export const EMPTY_APP_ROUTE: AppRoute = { workspaceId: null, settings: null, field: null, ctab: null, panel: null, view: null, help: false, setup: null }

const WORKSPACE_PATH = /^\/w\/([^/]+)\/?$/
const OVERLAY_KEYS = ['settings', 'ctab', 'panel', 'view', 'help', 'setup'] as const

const pick = <T extends string>(allowed: readonly T[], value: string | null): T | null =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null

/** Parse a location; an unknown path is `/` with no overlays, unknown param values are dropped. */
export function parseAppRoute(pathname: string, search: string): AppRoute {
  const m = WORKSPACE_PATH.exec(pathname)
  if (!m && pathname !== '/') return EMPTY_APP_ROUTE
  let workspaceId: string | null = null
  if (m) {
    try {
      workspaceId = decodeURIComponent(m[1])
    } catch (e) {
      if (!(e instanceof URIError)) throw e
      return EMPTY_APP_ROUTE // malformed escape (`/w/%E0`): an unknown path, redirected to `/`
    }
  }
  const q = new URLSearchParams(search)
  const settings = pick(SETTINGS_ROUTE_SECTIONS, q.get('settings'))
  return {
    workspaceId,
    settings,
    field: settings ? toSettingsFieldId(q.get('field')) : null,
    ctab: pick(CENTRAL_ROUTE_TABS, q.get('ctab')),
    panel: pick(BOTTOM_PANEL_ROUTE_IDS, q.get('panel')),
    view: pick(APP_ROUTE_VIEWS, q.get('view')),
    help: q.get('help') === '1',
    setup: q.get('setup') === '1' ? 'resume' : pick(SETUP_STEPS, q.get('setup')),
  }
}

/** The canonical href of a route (fixed param order), so equal routes compare equal as strings. */
export function buildAppHref(route: AppRoute): string {
  const path = route.workspaceId ? `/w/${encodeURIComponent(route.workspaceId)}` : '/'
  const q = new URLSearchParams()
  if (route.settings) q.set('settings', route.settings)
  if (route.settings && route.field) q.set('field', route.field)
  if (route.ctab) q.set('ctab', route.ctab)
  if (route.panel) q.set('panel', route.panel)
  if (route.view) q.set('view', route.view)
  if (route.help) q.set('help', '1')
  if (route.setup) q.set('setup', route.setup === 'resume' ? '1' : route.setup)
  const qs = q.toString()
  return qs ? `${path}?${qs}` : path
}

/** Push when the patch opens an overlay or switches board; replace for everything else. */
export function navigationMode(from: AppRoute, to: AppRoute): 'push' | 'replace' {
  if (to.workspaceId !== from.workspaceId) return 'push'
  return OVERLAY_KEYS.some((k) => !from[k] && to[k]) ? 'push' : 'replace'
}

/** URL setters; every one is a no-op when the URL would not change. */
export interface AppRouteActions {
  /** Open Settings on `section` (default Terminal) revealing `field`; already open → switch in place.
   *  No `field` clears the one in the URL (a later in-section move is not that link any more). */
  openSettings: (section?: SettingsRouteSection, field?: SettingsFieldId | null) => void
  closeSettings: () => void
  /** `replace` records what is already on screen (a side bar or panel restored at boot) without a Back step. */
  setCentralTab: (tab: CentralRouteTab | null, opts?: { replace?: boolean }) => void
  setPanel: (panel: BottomPanelRouteId | null, opts?: { replace?: boolean }) => void
  setView: (view: AppRouteView | null) => void
  setHelp: (open: boolean) => void
  /** Open the first-run wizard on a step (`resume` = first unfinished), or close it (null). */
  setSetup: (setup: SetupRoute | null) => void
  /** Show board `id` (null = no board). `replace` for corrections that must not add a Back step. */
  goWorkspace: (id: string | null, opts?: { replace?: boolean }) => void
}

// The route last navigated to by ANY `useAppRoute` instance, until the current task's microtasks
// run (by then React has the new location). Each instance's `latest` only knows its own calls: two
// instances navigating in one commit (App's workspace URL sync + the setup auto-open via the bridge)
// each built on the stale render and the second dropped the first's change (`?setup=` lost).
let pendingRoute: AppRoute | null = null

function makeActions(latest: { current: { route: AppRoute; navigate: NavigateFunction } }): AppRouteActions {
  const change = (patch: Partial<AppRoute>, forceReplace = false): void => {
    const from = pendingRoute ?? latest.current.route
    const to = { ...from, ...patch }
    const href = buildAppHref(to)
    if (href === buildAppHref(from)) return
    latest.current.navigate(href, { replace: forceReplace || navigationMode(from, to) === 'replace' })
    latest.current.route = to // a second call in the same tick builds on this one, not on the last render
    if (pendingRoute === null) queueMicrotask(() => { pendingRoute = null })
    pendingRoute = to
  }
  return {
    openSettings: (section = 'appearance', field = null) => change({ settings: section, field }),
    closeSettings: () => change({ settings: null, field: null }),
    setCentralTab: (ctab, opts) => change({ ctab }, opts?.replace === true),
    setPanel: (panel, opts) => change({ panel }, opts?.replace === true),
    setView: (view) => change({ view }),
    setHelp: (help) => change({ help }),
    setSetup: (setup) => change({ setup }),
    goWorkspace: (workspaceId, opts) => change({ workspaceId }, opts?.replace === true),
  }
}

/** The parsed URL plus stable setters. Needs a router above it (`BrowserRouter` / `MemoryRouter`). */
export function useAppRoute(): { route: AppRoute; actions: AppRouteActions } {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const route = useMemo(() => parseAppRoute(pathname, search), [pathname, search])
  const latest = useRef({ route, navigate })
  latest.current = { route, navigate }
  const actions = useMemo(() => makeActions(latest), [])
  return { route, actions }
}

let bridge: AppRouteActions | null = null

/** The URL setters for non-React callers (event buses); null until `AppRouteSync` has mounted. */
export function appNavigate(): AppRouteActions | null {
  return bridge
}

/** Mounted once inside the router: rewrites a non-canonical URL (unknown path → `/`, unknown
 *  values dropped) with `replace`, and publishes the setters to `appNavigate`. */
export function AppRouteSync(): null {
  const { pathname, search } = useLocation()
  const { route, actions } = useAppRoute()
  const navigate = useNavigate()
  useEffect(() => {
    const href = buildAppHref(route)
    if (href !== pathname + search) navigate(href, { replace: true })
  }, [route, pathname, search, navigate])
  useEffect(() => {
    bridge = actions
    return () => { if (bridge === actions) bridge = null }
  }, [actions])
  return null
}
