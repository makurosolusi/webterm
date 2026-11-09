// Side bar Project view leaves the open workspace out (the Layers section lists it); Status view
// stays cross-board for triage. Pure functions from `sessionList`, no DOM.
import { describe, expect, it } from 'vitest'
import { buildSessionList, buildStatusList, otherWorkspaceGroups, sidebarEmptyState } from './sessionList'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Workspace, WsNode } from '../shared/workspace'

// test-only fixtures
const node = (id: string): WsNode => ({ id, kind: 'terminal', x: 0, y: 0 })
const ws = (id: string, nodes: WsNode[]): Workspace => ({ id, name: id, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt: 0 })
const projects = [ws('p1', [node('a1')]), ws('p2', [node('b1')])]

describe('otherWorkspaceGroups', () => {
  it('drops the active workspace from the Project view', () => {
    const all = buildSessionList(projects, null, 'p1', {}, '')
    expect(all.map((g) => g.projectId)).toEqual(['p1', 'p2']) // WorkspaceBar still sees the active group
    expect(otherWorkspaceGroups(all).map((g) => g.projectId)).toEqual(['p2'])
  })

  it('Status view keeps the active workspace rows', () => {
    const ids = buildStatusList(projects, null, 'p1', {}, '').flatMap((s) => s.rows.map((r) => r.id))
    expect(ids).toContain('a1')
    expect(ids).toContain('b1')
  })
})

describe('sidebarEmptyState only-active', () => {
  it('names the case where the open workspace is the only one', () => {
    expect(sidebarEmptyState(true, '', true)).toBe('only-active')
    expect(sidebarEmptyState(true, '', false)).toBe('no-sessions')
    expect(sidebarEmptyState(true, 'x', true)).toBe('no-matches') // a filter miss wins
    expect(sidebarEmptyState(false, '', true)).toBe('none')
  })
})
