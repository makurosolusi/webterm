// A saved level change: one `permission.mode_change` per scope, and running Agent Chat sessions in the
// reached workspaces switched live (setMode), recorded per node too. Bun-only (pool + event bus).
import { afterEach, expect, test } from 'bun:test'
import type { Workspace, WsNode } from '../../shared/workspace'
import type { AppendEventInput, SenseEvent } from '../events/eventModel'
import { eventBus } from '../events/eventBus'
import { FakeQuery, fx } from '../agentChat/agentChat.fakeQuery'
import { AgentChatPool } from '../agentChat/agentChat.pool'
import type { ApprovalSettings } from '../../shared/settings.projectApprovalLevels'
import { approvalSessions, recordLevelChanges, switchAgentChats } from './permission.levelChange'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const ws = (id: string, nodes: string[]): Workspace => ({
  id, name: id, viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: nodes.map((n) => ({ id: n, kind: 'agentChat', x: 0, y: 0 }) as WsNode),
})
const AUTO: ApprovalSettings = { skipApprovals: false, claudePermissionMode: 'auto', projectApprovalLevels: {} }

let pool: AgentChatPool | undefined
afterEach(() => { pool?.closeAll(); pool = undefined })

function rig(list: Workspace[]) {
  const fqs = new Map<string, FakeQuery>()
  pool = new AgentChatPool({
    lookup: (nodeId) => {
      for (const w of list) { const node = w.nodes.find((n) => n.id === nodeId); if (node) return { ws: w, node } }
      return undefined
    },
    opener: (t) => (_resume, _can, _abort, input) => { const fq = new FakeQuery(input.prompt); fqs.set(t.node.id, fq); return fq.asQuery() },
  })
  return { pool, fqs }
}

test('recordLevelChanges: one event per changed scope, with Ask/Auto/Danger names only', () => {
  const seen: AppendEventInput[] = []
  const next: ApprovalSettings = { ...AUTO, claudePermissionMode: 'manual', projectApprovalLevels: { w1: 'never' } }
  const changes = recordLevelChanges(AUTO, next, 'human-ui', (e) => seen.push(e))
  expect(changes).toHaveLength(2)
  expect(seen.map((e) => [e.kind, e.actor, e.workspaceId, e.payload])).toEqual([
    ['permission.mode_change', 'human-ui', null, { scope: 'global', from: 'auto', to: 'ask' }],
    ['permission.mode_change', 'human-ui', 'w1', { scope: 'workspace', from: 'auto', to: 'danger' }],
  ])
  expect(recordLevelChanges(next, next, 'human-ui', (e) => seen.push(e))).toEqual([])
})

test('switchAgentChats: running chats in the changed workspace switch live; others keep their mode', async () => {
  const { pool, fqs } = rig([ws('w1', ['a']), ws('w2', ['b'])])
  pool.send('a', 'hi')
  pool.send('b', 'hi')
  fqs.get('a')?.emit(fx.init('s-a'))
  fqs.get('b')?.emit(fx.init('s-b'))
  await tick()
  const seen: SenseEvent[] = []
  const off = eventBus.subscribe('permission.*', (e) => seen.push(e))
  try {
    const next: ApprovalSettings = { ...AUTO, projectApprovalLevels: { w1: 'always' } }
    expect(await switchAgentChats(recordLevelChanges(AUTO, next, 'human-ui'), next, pool)).toBe(1)
    expect(fqs.get('a')?.modes).toEqual(['default'])
    expect(fqs.get('b')?.modes).toEqual([])
    const node = seen.find((e) => e.nodeId === 'a')
    expect(node).toMatchObject({ kind: 'permission.mode_change', actor: 'settings', workspaceId: 'w1', payload: { scope: 'node', to: 'manual' } })
    // Global change: w2 follows (no override), w1 keeps its own Ask.
    const danger: ApprovalSettings = { ...next, skipApprovals: true }
    expect(await switchAgentChats(recordLevelChanges(next, danger, 'human-ui'), danger, pool)).toBe(1)
    expect(fqs.get('b')?.modes).toEqual(['bypassPermissions'])
    expect(fqs.get('a')?.modes).toEqual(['default'])
  } finally { off() }
})

test('approvalSessions: the mode that applies and nothing stale with no recorded launches', () => {
  expect(approvalSessions({ ...AUTO, projectApprovalLevels: { w1: 'never' } }, () => false, 'w1')).toEqual({ workspaceId: 'w1', mode: 'danger', staleSessions: 0 })
  expect(approvalSessions(AUTO, () => false)).toEqual({ workspaceId: null, mode: 'auto', staleSessions: 0 })
})
