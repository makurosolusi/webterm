/** @vitest-environment jsdom */
// Omnibox, the canvas menu and the Dock all add agents through `onAddAgent` (App.board); a new
// builtin Claude node made there records the default launch profile.
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Node } from '@xyflow/react'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { Workspace } from '../../shared/workspace'
import { useBoardActions } from '../App.board'

function board() {
  let nodes: Node[] = []
  const setNodes = vi.fn((u: Node[] | ((p: Node[]) => Node[])) => { nodes = typeof u === 'function' ? u(nodes) : u })
  const ws: Workspace = { id: 'w', name: 'W', cwd: '/r', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 0 }
  const { result } = renderHook(() => useBoardActions({
    rf: { current: null }, activeWsRef: { current: ws }, nodesRef: { current: [] }, edgesRef: { current: [] },
    settings: { ...DEFAULT_SETTINGS, defaultClaudeProfileId: 'm' }, activeId: 'w', browserReady: false,
    setActiveWs: vi.fn(), setNodes, setEdges: vi.fn(), flushSave: vi.fn(), scheduleSave: vi.fn(),
    resetViewport: vi.fn(), resetLayout: vi.fn(), pushLayout: vi.fn(), recordClosed: vi.fn(),
  }))
  return { add: result.current.onAddAgent, data: () => nodes.map((n) => n.data as { agentId?: string; claudeProfileId?: string }) }
}

describe('new agent nodes from Omnibox / canvas menu / Dock', () => {
  it('a builtin Claude node carries the default claudeProfileId; other agents none', () => {
    const b = board()
    b.add('claude', 'claude')
    b.add('codex', 'codex')
    expect(b.data()).toMatchObject([{ agentId: 'claude', claudeProfileId: 'm' }, { agentId: 'codex' }])
    expect(b.data()[1]?.claudeProfileId).toBeUndefined()
  })
})
