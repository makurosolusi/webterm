// Claude view switch (agentChat.view.ts) over fakes for every dep: the session id carried both ways,
// the exact patches, every refusal with nothing stopped or patched, stop-before-update order, failures.
import { afterAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Workspace, WsNode } from '../../shared/workspace'
import type { CanvasUpdateInput, CanvasUpdateResult } from '../canvas/canvasPush'
import { execWrite } from '../ledger/ledgerCore'
import { openLedgerDb } from '../ledger/migration'
import { json, routeCtx } from '../routes/route.core'
import { CLAUDE_VIEW_HINTS, claudeViewRoute, isCentralWorkerNode, switchClaudeView, type ClaudeViewDeps } from './agentChat.view'

const SID = '0b6c7a3e-1111-4222-8333-444455556666' // test-only
const SID2 = '9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff' // test-only
const LAUNCH = 'claude --profile-test' // test-only

const chatNode = (o: Partial<WsNode> = {}): WsNode =>
  ({ id: 'n1', kind: 'agentChat', x: 10, y: 20, width: 500, height: 400, title: 'Mine', color: '#f00', claudeProfileId: 'p1', chatSessionId: SID, permissionMode: 'plan', chatConfig: { model: 'opus', effort: 'high', thinking: false }, ...o })
const termNode = (o: Partial<WsNode> = {}): WsNode =>
  ({ id: 'n1', kind: 'agent', agentId: 'claude', x: 10, y: 20, claudeProfileId: 'p1', sessionId: SID, cmd: 'claude', ...o })

interface Rig {
  deps: ClaudeViewDeps
  calls: string[]
  patches: CanvasUpdateInput[]
  closed: Array<{ nodeId: string; reason?: string }>
  closedNodes: WsNode[][]
  profiles: Array<string | undefined>
}

function rig(node: WsNode, o: {
  live?: { busy: boolean; sessionId?: string }; pending?: number; status?: string; transcript?: boolean; central?: boolean
  update?: (i: CanvasUpdateInput) => CanvasUpdateResult
} = {}): Rig {
  const ws: Workspace = { id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 1, nodes: [node] }
  const r: Rig = { calls: [], patches: [], closed: [], closedNodes: [], profiles: [], deps: undefined as unknown as ClaudeViewDeps }
  r.deps = {
    canvas: {
      workspaceOfNode: (id) => (ws.nodes.some((n) => n.id === id) ? ws : null),
      update: (i) => {
        r.calls.push('update')
        r.patches.push(i)
        if (o.update) return o.update(i)
        const p = i.patches[0]!
        const next: Record<string, unknown> = { ...node }
        for (const [k, v] of Object.entries(p)) if (v === null) delete next[k]; else next[k] = v
        return { ok: true, updatedAt: 2, nodes: [next as unknown as WsNode], bridges: [], unlinked: [] }
      },
    },
    pool: {
      peek: () => (o.live ? { busy: () => o.live!.busy } : undefined),
      sessionId: () => o.live?.sessionId,
      close: (nodeId, reason) => { r.calls.push('close'); r.closed.push({ nodeId, reason }) },
      gate: { pending: () => Array.from({ length: o.pending ?? 0 }) },
    },
    closeNodes: (nodes) => { r.calls.push('closeNodes'); r.closedNodes.push([...nodes]) },
    statusOf: () => o.status,
    hasTranscript: () => o.transcript ?? true,
    isCentralWorker: () => o.central ?? false,
    launchLine: (p) => { r.profiles.push(p); return LAUNCH },
  }
  return r
}

const nothingDone = (r: Rig): void => {
  expect(r.calls).toEqual([])
}

describe('chat -> terminal', () => {
  test('carries the stored chat session id, closes the chat before ONE update with the exact patch', () => {
    const r = rig(chatNode())
    const res = switchClaudeView(r.deps, 'n1', 'terminal')
    expect(res.status).toBe(200)
    expect(r.calls).toEqual(['close', 'update'])
    expect(r.patches).toEqual([{ workspaceId: 'w1', patches: [{ id: 'n1', kind: 'agent', agentId: 'claude', sessionId: SID, chatSessionId: null, cmd: LAUNCH }] }])
    expect(r.profiles).toEqual(['p1'])
    if (res.status !== 200) throw new Error('refused')
    // Chat config, mode, profile and layout stay on the node so switching back restores them.
    expect(res.body.node).toMatchObject({ id: 'n1', kind: 'agent', x: 10, y: 20, width: 500, title: 'Mine', color: '#f00', claudeProfileId: 'p1', permissionMode: 'plan', chatConfig: { model: 'opus' } })
    expect('chatSessionId' in res.body.node).toBe(false)
  })

  test('a live pool session: its in-memory id wins, and the pool is closed before the update', () => {
    const r = rig(chatNode(), { live: { busy: false, sessionId: SID2 } })
    expect(switchClaudeView(r.deps, 'n1', 'terminal').status).toBe(200)
    expect(r.calls).toEqual(['close', 'update'])
    expect(r.closed).toEqual([{ nodeId: 'n1', reason: 'switched to terminal' }])
    expect(r.patches[0]!.patches[0]!.sessionId).toBe(SID2)
  })

  test('a live session after "new conversation" (no id) goes to the terminal with sessionId null', () => {
    const r = rig(chatNode(), { live: { busy: false } })
    expect(switchClaudeView(r.deps, 'n1', 'terminal').status).toBe(200)
    expect(r.patches[0]!.patches[0]!.sessionId).toBe(null)
  })

  test('an invalid session id is dropped, never passed into the launch', () => {
    const r = rig(chatNode({ chatSessionId: 'x; rm -rf ~' }))
    expect(switchClaudeView(r.deps, 'n1', 'terminal').status).toBe(200)
    expect(r.patches[0]!.patches[0]!.sessionId).toBe(null)
    const flag = rig(chatNode(), { live: { busy: false, sessionId: '--dangerously-skip-permissions' } })
    switchClaudeView(flag.deps, 'n1', 'terminal')
    expect(flag.patches[0]!.patches[0]!.sessionId).toBe(null)
  })

  test('no profile id: the launch line is asked for the default profile', () => {
    const r = rig(chatNode({ claudeProfileId: undefined }))
    switchClaudeView(r.deps, 'n1', 'terminal')
    expect(r.profiles).toEqual([undefined])
  })

  test('busy chat (mid-turn or pending permission) -> 409, nothing stopped or patched', () => {
    for (const o of [{ live: { busy: true, sessionId: SID } }, { live: { busy: false, sessionId: SID }, pending: 1 }, { pending: 1 }]) {
      const r = rig(chatNode(), o)
      expect(switchClaudeView(r.deps, 'n1', 'terminal')).toEqual({ status: 409, body: { ok: false, code: 'busy', hint: CLAUDE_VIEW_HINTS.busy } })
      nothingDone(r)
    }
  })
})

describe('terminal -> chat', () => {
  test('ends the PTY as a human close does, then ONE update carrying the session id', () => {
    const node = termNode()
    const r = rig(node)
    const res = switchClaudeView(r.deps, 'n1', 'chat')
    expect(res.status).toBe(200)
    expect(r.calls).toEqual(['closeNodes', 'update'])
    expect(r.closedNodes).toEqual([[node]])
    expect(r.patches).toEqual([{ workspaceId: 'w1', patches: [{ id: 'n1', kind: 'agentChat', chatSessionId: SID, sessionId: null }] }])
    if (res.status !== 200) throw new Error('refused')
    expect(res.body.node).toMatchObject({ id: 'n1', kind: 'agentChat', chatSessionId: SID, claudeProfileId: 'p1', x: 10, y: 20 })
  })

  test('no transcript on disk (minted, never used) -> a fresh chat (chatSessionId null)', () => {
    const r = rig(termNode(), { transcript: false })
    expect(switchClaudeView(r.deps, 'n1', 'chat').status).toBe(200)
    expect(r.patches[0]!.patches[0]!.chatSessionId).toBe(null)
  })

  test('an invalid or missing session id -> chatSessionId null', () => {
    for (const sessionId of ['$(id)', undefined]) {
      const r = rig(termNode({ sessionId }))
      expect(switchClaudeView(r.deps, 'n1', 'chat').status).toBe(200)
      expect(r.patches[0]!.patches[0]!.chatSessionId).toBe(null)
    }
  })

  test('busy terminal (working, blocked) -> 409, nothing stopped or patched; done is not busy', () => {
    for (const status of ['working', 'blocked']) {
      const r = rig(termNode(), { status })
      expect(switchClaudeView(r.deps, 'n1', 'chat')).toEqual({ status: 409, body: { ok: false, code: 'busy', hint: CLAUDE_VIEW_HINTS.busy } })
      nothingDone(r)
    }
    expect(switchClaudeView(rig(termNode(), { status: 'done' }).deps, 'n1', 'chat').status).toBe(200)
  })

  test("'waiting' (idle after Stop) is not busy -> switches to chat", () => {
    const r = rig(termNode(), { status: 'waiting' })
    const res = switchClaudeView(r.deps, 'n1', 'chat')
    expect(res.status).toBe(200)
    if (res.status !== 200) throw new Error('refused')
    expect(res.body.node).toMatchObject({ id: 'n1', kind: 'agentChat' })
  })

  test('split terminal -> 400 split_terminal; one pane leaf is fine', () => {
    const split = rig(termNode({ panes: { dir: 'h', ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1:p1' } } }))
    expect(switchClaudeView(split.deps, 'n1', 'chat')).toEqual({ status: 400, body: { ok: false, code: 'split_terminal', hint: 'Close the extra panes first.' } })
    nothingDone(split)
    expect(switchClaudeView(rig(termNode({ panes: { id: 'n1' } })).deps, 'n1', 'chat').status).toBe(200)
  })

  test('a Central worker stays a terminal', () => {
    const r = rig(termNode(), { central: true })
    expect(switchClaudeView(r.deps, 'n1', 'chat')).toEqual({ status: 400, body: { ok: false, code: 'central_worker', hint: CLAUDE_VIEW_HINTS.central_worker } })
    nothingDone(r)
  })
})

describe('refusals and no-ops', () => {
  test('unknown or unsafe node id -> 404 node_not_found', () => {
    const r = rig(chatNode())
    expect(switchClaudeView(r.deps, 'nope', 'terminal')).toEqual({ status: 404, body: { ok: false, code: 'node_not_found' } })
    expect(switchClaudeView(r.deps, '../n1', 'terminal').status).toBe(404)
    nothingDone(r)
  })

  test('not a Claude node -> 400 not_claude, both directions', () => {
    for (const [node, to] of [[termNode({ agentId: 'codex' }), 'chat'], [termNode({ agentId: 'codex' }), 'terminal'], [termNode({ kind: 'terminal', agentId: undefined }), 'chat'], [termNode({ kind: 'browser' }), 'terminal']] as const) {
      const r = rig(node)
      expect(switchClaudeView(r.deps, 'n1', to)).toEqual({ status: 400, body: { ok: false, code: 'not_claude', hint: CLAUDE_VIEW_HINTS.not_claude } })
      nothingDone(r)
    }
  })

  test('already in the requested view -> 200 with the node, nothing changes', () => {
    const chat = chatNode()
    const a = rig(chat, { live: { busy: true } })
    expect(switchClaudeView(a.deps, 'n1', 'chat')).toEqual({ status: 200, body: { ok: true, node: chat } })
    nothingDone(a)
    const term = termNode()
    const b = rig(term, { status: 'working' })
    expect(switchClaudeView(b.deps, 'n1', 'terminal')).toEqual({ status: 200, body: { ok: true, node: term } })
    nothingDone(b)
  })

  test('process stopped but the board update refused or threw -> 500 switch_failed', () => {
    const refused = rig(chatNode(), { update: () => ({ ok: false, code: 'node_not_found' }) })
    expect(switchClaudeView(refused.deps, 'n1', 'terminal')).toEqual({ status: 500, body: { ok: false, code: 'switch_failed' } })
    expect(refused.calls).toEqual(['close', 'update'])
    const threw = rig(termNode(), { update: () => { throw new Error('disk full') } })
    expect(switchClaudeView(threw.deps, 'n1', 'chat')).toEqual({ status: 500, body: { ok: false, code: 'switch_failed' } })
    expect(threw.calls).toEqual(['closeNodes', 'update'])
  })

  test('a stop that throws -> 500 switch_failed and no board update', () => {
    const r = rig(termNode())
    r.deps.closeNodes = () => { throw new Error('kill failed') }
    expect(switchClaudeView(r.deps, 'n1', 'chat')).toEqual({ status: 500, body: { ok: false, code: 'switch_failed' } })
    expect(r.calls).toEqual([])
  })
})

describe('isCentralWorkerNode', () => {
  test('a live pty Central agent matches by node_id or c-<id>; ended or exec agents do not', () => {
    const db = openLedgerDb(':memory:')
    const add = (id: string, nodeId: string | null, runner: string, state: string) => execWrite(db,
      `INSERT INTO central_agents (id, project_id, node_id, kind, runner, state, owner, started_at) VALUES (?, 'p', ?, 'claude', ?, ?, 'orchestrator', 1)`,
      id, nodeId, runner, state)
    add('a1', 'node-live', 'pty', 'working')
    add('a2', null, 'pty', 'working')
    add('a3', 'node-ended', 'pty', 'closed')
    add('a4', 'node-exec', 'exec', 'working')
    expect(isCentralWorkerNode(db, 'node-live')).toBe(true)
    expect(isCentralWorkerNode(db, 'c-a2')).toBe(true)
    expect(isCentralWorkerNode(db, 'node-ended')).toBe(false)
    expect(isCentralWorkerNode(db, 'node-exec')).toBe(false)
    expect(isCentralWorkerNode(db, 'other')).toBe(false)
  })
})

// The bun:test shim has no beforeAll: the server listens at module load (top-level await).
let resolved = 0
const server = createServer((req, res) => {
  const c = routeCtx(req, res, async () => {})
  void claudeViewRoute(c, async () => { resolved++; return rig(chatNode()).deps }).catch((err: unknown) => json(res, 500, { error: String(err) }))
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude-view/n1`
afterAll(() => { server.close() })

describe('route', () => {
  const post = (body: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

  test('a body that is not exactly {to} with a valid value -> 400 bad_request, deps never resolved', async () => {
    for (const body of ['', 'not json', '[]', '{}', '{"to":"browser"}', '{"to":"chat","x":1}', 'x'.repeat(4096)]) {
      const r = await post(body)
      expect(`${body.slice(0, 20)}: ${r.status}`).toBe(`${body.slice(0, 20)}: 400`)
      expect(await r.json()).toEqual({ ok: false, code: 'bad_request' })
    }
    expect(resolved).toBe(0)
  })

  test('a valid body switches and answers {ok, node}; GET is refused', async () => {
    const r = await post('{"to":"terminal"}')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, node: { id: 'n1', kind: 'agent', sessionId: SID } })
    expect((await fetch(url)).status).toBe(405)
  })
})
