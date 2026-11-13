// Side bar Sessions view: the Project tab lists every workspace (the open one included, marked
// Current); `otherWorkspaceGroups` survives only for the activity bar badge. Status view is
// cross-board. Pure functions, no DOM.
import { describe, expect, it } from 'vitest'
import { buildSessionList, buildStatusList, otherWorkspaceGroups, sidebarEmptyState } from './sessionList'
import { workspaceSubline } from './sessionList.workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Workspace, WsNode } from '../shared/workspace'

// test-only fixtures
const node = (id: string): WsNode => ({ id, kind: 'terminal', x: 0, y: 0 })
const ws = (id: string, nodes: WsNode[]): Workspace => ({ id, name: id, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt: 0 })
const projects = [ws('p1', [node('a1')]), ws('p2', [node('b1')])]

describe('otherWorkspaceGroups (activity bar badge)', () => {
  it('drops the active workspace', () => {
    const all = buildSessionList(projects, null, 'p1', {}, '')
    expect(all.map((g) => g.projectId)).toEqual(['p1', 'p2'])
    expect(otherWorkspaceGroups(all).map((g) => g.projectId)).toEqual(['p2'])
  })

  it('Status view keeps the active workspace rows', () => {
    const ids = buildStatusList(projects, null, 'p1', {}, '').flatMap((s) => s.rows.map((r) => r.id))
    expect(ids).toContain('a1')
    expect(ids).toContain('b1')
  })
})

describe('sidebarEmptyState', () => {
  it('a filter miss is no-matches, otherwise no-sessions', () => {
    expect(sidebarEmptyState(true, '')).toBe('no-sessions')
    expect(sidebarEmptyState(true, 'x')).toBe('no-matches')
    expect(sidebarEmptyState(false, 'x')).toBe('none')
  })

  it('while workspaces are not hydrated (boot) it is loading, never "no sessions"', () => {
    expect(sidebarEmptyState(true, '', true)).toBe('loading')
    expect(sidebarEmptyState(false, '', true)).toBe('none')
  })
})

describe('workspace header', () => {
  it('second line: folder name, then the branch when known', () => {
    expect(workspaceSubline('/Users/me/dev/laya-api', 'main')).toBe('laya-api · main')
    expect(workspaceSubline('/Users/me/dev/laya-api', undefined)).toBe('laya-api')
    expect(workspaceSubline(undefined, undefined)).toBe('')
  })
})
