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
      workspaceId: 'ws-1', settings: 'canvas', field: null, ctab: 'skills', panel: 'problems', view: 'kanban', help: true, setup: null,
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

  it('reads ?setup=1 as resume and ?setup=<step>; unknown steps are dropped', () => {
    expect(parseAppRoute('/', '?setup=1').setup).toBe('resume')
    expect(parseAppRoute('/', '?setup=central').setup).toBe('central')
    expect(parseAppRoute('/', '?setup=keymap').setup).toBeNull()
    expect(buildAppHref({ ...EMPTY_APP_ROUTE, setup: 'resume' })).toBe('/?setup=1')
  })

  it('reads `&field=` only with a section and only for a known setting id', () => {
    expect(parseAppRoute('/', '?settings=central&field=central.level').field).toBe('central.level')
    expect(parseAppRoute('/', '?settings=claude&field=agentApprovalLevel').field).toBe('agentApprovalLevel')
    expect(parseAppRoute('/', '?settings=capabilities&field=capability.telegram').field).toBe('capability.telegram')
    expect(parseAppRoute('/', '?settings=central&field=nope').field).toBeNull()
    expect(parseAppRoute('/', '?settings=central&field="]x').field).toBeNull() // never reaches a CSS selector
    expect(parseAppRoute('/', '?field=central.profile')).toEqual(EMPTY_APP_ROUTE)
    expect(buildAppHref({ ...EMPTY_APP_ROUTE, field: 'skipApprovals' })).toBe('/') // no section, no field
  })

  it('decodes the workspace id and accepts a trailing slash', () => {
    expect(parseAppRoute('/w/a%20b/', '').workspaceId).toBe('a b')
  })
})

describe('moved settings', () => {
  it('a legacy page id or a moved field lands on the new page with the new field', () => {
    expect(parseAppRoute('/', '?settings=agent&field=skipApprovals')).toMatchObject({ settings: 'claude', field: 'agentApprovalLevel' })
    expect(parseAppRoute('/', '?settings=agent&field=claudeLaunchProfiles')).toMatchObject({ settings: 'claude', field: 'claudeLaunchProfiles' })
    expect(parseAppRoute('/', '?settings=central&field=central.profile')).toMatchObject({ settings: 'claude', field: 'centralClaudeProfileId' })
    expect(parseAppRoute('/', '?settings=central&field=central.contextWindow')).toMatchObject({ settings: 'central', field: 'central.central' })
    expect(parseAppRoute('/', '?settings=central&field=central.askEachWorker')).toMatchObject({ settings: 'central', field: 'central.level' })
    expect(parseAppRoute('/', '?settings=agent')).toMatchObject({ settings: 'claude', field: null })
  })
})

describe('buildAppHref', () => {
  it('round-trips through parse with a fixed param order', () => {
    const route: AppRoute = { workspaceId: 'a b', settings: 'central', field: 'central.level', ctab: 'memory', panel: 'tasks', view: 'kanban', help: true, setup: 'browser' }
    const href = buildAppHref(route)
    expect(href).toBe('/w/a%20b?settings=central&field=central.level&ctab=memory&panel=tasks&view=kanban&help=1&setup=browser')
    const [path, search] = href.split('?')
    expect(parseAppRoute(path, `?${search}`)).toEqual(route)
    expect(buildAppHref(parseAppRoute('/', '?help=1&settings=canvas'))).toBe('/?settings=canvas&help=1')
    expect(buildAppHref(EMPTY_APP_ROUTE)).toBe('/')
  })
})

describe('navigationMode', () => {
  const at = (over: Partial<AppRoute>): AppRoute => ({ ...EMPTY_APP_ROUTE, workspaceId: 'a', ...over })
  it('opening an overlay or switching board pushes (Back undoes it)', () => {
    expect(navigationMode(at({}), at({ settings: 'terminal' }))).toBe('push')
    expect(navigationMode(at({}), at({ help: true }))).toBe('push')
    expect(navigationMode(at({}), at({ workspaceId: 'b' }))).toBe('push')
    expect(navigationMode(at({}), at({ setup: 'resume' }))).toBe('push')
    expect(navigationMode(at({ setup: 'claude' }), at({ setup: 'browser' }))).toBe('replace')
  })
  it('changing or closing an open overlay replaces', () => {
    expect(navigationMode(at({ settings: 'terminal' }), at({ settings: 'canvas' }))).toBe('replace')
    expect(navigationMode(at({ settings: 'central', field: 'central.level' }), at({ settings: 'central' }))).toBe('replace')
    expect(navigationMode(at({}), at({ settings: 'central', field: 'central.level' }))).toBe('push')
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
    expect(parseAppRoute('/', '?ctab=health').ctab).toBe('health')
  })
  it('bottom panel ids are the view ids', () => {
    expect([...BOTTOM_PANEL_ROUTE_IDS].sort()).toEqual(['activity', 'output', 'problems', 'tasks'])
  })
})

describe('toSettingsRouteSection', () => {
  it('maps legacy ids, keeps known ones, sends the rest to Appearance (the first page)', () => {
    expect(toSettingsRouteSection('background:workspace')).toBe('appearance')
    expect(toSettingsRouteSection('background')).toBe('appearance')
    expect(toSettingsRouteSection('interaction')).toBe('terminal')
    expect(toSettingsRouteSection('shell')).toBe('terminal')
    expect(toSettingsRouteSection('terminal')).toBe('terminal')
    expect(toSettingsRouteSection('canvas-background')).toBe('appearance')
    expect(toSettingsRouteSection('env')).toBe('capabilities')
    expect(toSettingsRouteSection('control')).toBe('health')
    expect(toSettingsRouteSection('memory')).toBe('memory')
    expect(toSettingsRouteSection('preview')).toBe('appearance')
  })
})
