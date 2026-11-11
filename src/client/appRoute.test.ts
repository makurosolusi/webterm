// URL contract (./appRoute): whitelists, unknown values dropped, canonical round-trip, push/replace.
import { describe, expect, it } from 'vitest'
import {
  BOTTOM_PANEL_ROUTE_IDS, CENTRAL_ROUTE_TABS, EMPTY_APP_ROUTE, SETTINGS_ROUTE_SECTIONS,
  buildAppHref, navigationMode, parseAppRoute, toSettingsRouteSection, type AppRoute,
} from './appRoute'
import { SETTINGS_SECTIONS } from './SettingsPanel'
import { knownTab } from './central/CentralControlPanel'

describe('parseAppRoute', () => {
  it('reads the board and every overlay', () => {
    expect(parseAppRoute('/w/ws-1', '?settings=canvas&ctab=skills&panel=problems&view=kanban&help=1')).toEqual({
      workspaceId: 'ws-1', settings: 'canvas', ctab: 'skills', panel: 'problems', view: 'kanban', help: true,
    })
    expect(parseAppRoute('/', '')).toEqual(EMPTY_APP_ROUTE)
  })

  it('drops values outside the whitelists', () => {
    expect(parseAppRoute('/', '?settings=nope&ctab=approvals&panel=x&view=list&help=yes&other=1')).toEqual(EMPTY_APP_ROUTE)
    expect(parseAppRoute('/', '?settings=')).toEqual(EMPTY_APP_ROUTE)
  })

  it('an unknown path is `/` with no overlays', () => {
    expect(parseAppRoute('/settings', '?settings=canvas')).toEqual(EMPTY_APP_ROUTE)
    expect(parseAppRoute('/w/a/b', '')).toEqual(EMPTY_APP_ROUTE)
    expect(parseAppRoute('/w/%E0', '')).toEqual(EMPTY_APP_ROUTE)
  })

  it('decodes the workspace id and accepts a trailing slash', () => {
    expect(parseAppRoute('/w/a%20b/', '').workspaceId).toBe('a b')
  })
})

describe('buildAppHref', () => {
  it('round-trips through parse with a fixed param order', () => {
    const route: AppRoute = { workspaceId: 'a b', settings: 'health', ctab: 'memory', panel: 'tasks', view: 'kanban', help: true }
    const href = buildAppHref(route)
    expect(href).toBe('/w/a%20b?settings=health&ctab=memory&panel=tasks&view=kanban&help=1')
    const [path, search] = href.split('?')
    expect(parseAppRoute(path, `?${search}`)).toEqual(route)
    expect(buildAppHref(parseAppRoute('/', '?help=1&settings=shell'))).toBe('/?settings=shell&help=1')
    expect(buildAppHref(EMPTY_APP_ROUTE)).toBe('/')
  })
})

describe('navigationMode', () => {
  const at = (over: Partial<AppRoute>): AppRoute => ({ ...EMPTY_APP_ROUTE, workspaceId: 'a', ...over })
  it('opening an overlay or switching board pushes (Back undoes it)', () => {
    expect(navigationMode(at({}), at({ settings: 'terminal' }))).toBe('push')
    expect(navigationMode(at({}), at({ help: true }))).toBe('push')
    expect(navigationMode(at({}), at({ workspaceId: 'b' }))).toBe('push')
  })
  it('changing or closing an open overlay replaces', () => {
    expect(navigationMode(at({ settings: 'terminal' }), at({ settings: 'canvas' }))).toBe('replace')
    expect(navigationMode(at({ settings: 'terminal' }), at({}))).toBe('replace')
    expect(navigationMode(at({ ctab: 'status' }), at({ ctab: 'agents' }))).toBe('replace')
  })
})

describe('whitelists match the surfaces they open', () => {
  it('settings sections = SETTINGS_SECTIONS ids, Account included', () => {
    expect([...SETTINGS_ROUTE_SECTIONS]).toEqual(SETTINGS_SECTIONS.map((s) => s.id))
    expect(parseAppRoute('/', '?settings=account').settings).toBe('account')
  })
  it('every Central tab is one the panel has', () => {
    for (const t of CENTRAL_ROUTE_TABS) expect(knownTab(t)).toBe(t)
  })
  it('bottom panel ids are the view ids', () => {
    expect([...BOTTOM_PANEL_ROUTE_IDS].sort()).toEqual(['activity', 'output', 'problems', 'tasks'])
  })
})

describe('toSettingsRouteSection', () => {
  it('maps legacy ids, keeps known ones, sends the rest to Terminal', () => {
    expect(toSettingsRouteSection('background:workspace')).toBe('background')
    expect(toSettingsRouteSection('env')).toBe('capabilities')
    expect(toSettingsRouteSection('control')).toBe('health')
    expect(toSettingsRouteSection('memory')).toBe('memory')
    expect(toSettingsRouteSection('preview')).toBe('terminal')
  })
})
