import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNode } from '../../../canvas/canvasPush'
import { MAX_PROMPT_CHARS } from '../../../control/controlTypes'
import { allRows } from '../../../ledger/ledgerCore'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx, Tier } from '../toolTypes'
import { createCanvasTypeDefs, type TypeSessions } from './canvas.type.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board of project p1 (workspace w-p1, seeded by seedPortfolio).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
  { id: 'n2', kind: 'browser', x: 0, y: 0, name: 'Kiwi', url: 'https://example.com/' },
  { id: 'n3', kind: 'agent', x: 0, y: 0, name: 'Fern', agentId: 'claude' },
  { id: 'n4', kind: 'terminal', x: 0, y: 0, name: 'Otter' },
  { id: 'c-ag1', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
  { id: 'c-ag2', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
]
const SECRET = 'export API_PASS=hunter2'

let f: Fixture
let unregister = (): void => undefined
let typed: Array<[string, string]>
const fake: TypeSessions = { isLive: (id) => id !== 'n4', input: (id, data) => { typed.push([id, data]) } }

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); typed = []
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD } : null))
  // ag1 is a live worker; ag2 has ended (its node is an ordinary leftover).
  f.db.exec(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES
    ('ag1', 'p1', 'claude', 'pty', 'working', 'central:global', 1), ('ag2', 'p1', 'claude', 'pty', 'closed', 'central:global', 1)`)
})
afterEach(() => { unregister(); f.close() })

function ctx(maxTier: Tier = 'R2', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createCanvasTypeDefs({ sessions: async () => fake }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const type = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.type', { projectId: 'p1', ...input })

describe('canvas.type', () => {
  it('is R2 behind the read-tools flag', async () => {
    expect(createCanvasTypeDefs({ sessions: () => fake }).map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.type', 'R2', READ_TOOLS_FLAG]])
    expect(await type({ nodeId: 'n1', text: 'ls' }, ctx('R1'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await type({ nodeId: 'n1', text: 'ls' }, ctx('R2', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(typed).toEqual([])
  })

  it('types the text then Enter into the node session', async () => {
    const res = await type({ nodeId: 'n1', text: 'npm test' })
    expect(typed).toEqual([['n1', 'npm test\r']])
    expect(res).toMatchObject({ ok: true, data: { nodeId: 'n1', name: 'Mango', submitted: true, length: 8 } })
  })

  it('submit false types without Enter', async () => {
    expect(await type({ nodeId: 'n1', text: 'git st', submit: false })).toMatchObject({ ok: true, data: { submitted: false, length: 6 } })
    expect(typed).toEqual([['n1', 'git st']])
  })

  it('resolves a name case-insensitively and types into a Claude node', async () => {
    expect(await type({ nodeId: 'mango', text: 'pwd' })).toMatchObject({ ok: true, data: { nodeId: 'n1', name: 'Mango' } })
    expect(await type({ nodeId: 'FERN', text: 'hi' })).toMatchObject({ ok: true, data: { nodeId: 'n3', name: 'Fern' } })
    expect(typed).toEqual([['n1', 'pwd\r'], ['n3', 'hi\r']])
  })

  it('rejects malformed input before touching a session', async () => {
    const bad = [
      { nodeId: 'n1', text: '' }, { nodeId: 'n1', text: 'x'.repeat(MAX_PROMPT_CHARS + 1) }, { nodeId: 'n1', text: 'a\x1b[2Jb' },
      { nodeId: 'n1', text: 'ls', submit: 'yes' }, { nodeId: 'n1', text: 'ls', extra: 1 }, { nodeId: 'a/b', text: 'ls' }, { nodeId: 'n1' },
    ]
    for (const input of bad) expect(await type(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(typed).toEqual([])
  })

  it('refuses unknown nodes, non-terminals, live workers and dead sessions', async () => {
    expect(await type({ nodeId: 'Ghost', text: 'ls' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(await type({ nodeId: 'Kiwi', text: 'ls' })).toMatchObject({ ok: false, code: 'not_a_terminal', data: { kind: 'browser' } })
    expect(await type({ nodeId: 'c-ag1', text: 'ls' })).toMatchObject({ ok: false, code: 'use_agent_tool', data: { agentRef: 'ag1', hint: expect.stringContaining('agent.prompt') } })
    expect(await type({ nodeId: 'Otter', text: 'ls' })).toMatchObject({ ok: false, code: 'session_not_running', data: { hint: expect.stringContaining('restart') } })
    expect(await execTool(ctx(), 'canvas.type', { projectId: 'p2', nodeId: 'n1', text: 'ls' })).toMatchObject({ ok: false, code: 'workspace_not_found' })
    expect(typed).toEqual([])
    // An ended worker's node is an ordinary leftover terminal.
    expect(await type({ nodeId: 'c-ag2', text: 'ls' })).toMatchObject({ ok: true })
  })

  it('never puts the typed text in the result or the audit ledger', async () => {
    const res = await type({ nodeId: 'n1', text: SECRET })
    expect(typed).toEqual([['n1', `${SECRET}\r`]])
    expect(JSON.stringify([res, allRows(f.db, 'SELECT payload_json FROM event')])).not.toContain('hunter2')
    const audit = allRows(f.db, 'SELECT payload_json FROM event').map((r) => JSON.parse(String(r['payload_json'])))
    expect(audit).toContainEqual(expect.objectContaining({ tool: 'canvas.type', nodeId: 'n1', length: SECRET.length, submitted: true }))
  })
})
