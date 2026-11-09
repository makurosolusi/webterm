import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNode } from '../../../canvas/canvasPush'
import type { ChatPort } from '../../../agentChat/agentChat.port'
import { allRows } from '../../../ledger/ledgerCore'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx, Tier } from '../toolTypes'
import { createChatDefs, MAX_CHAT_TEXT } from './chat.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board of project p1 (workspace w-p1, seeded by seedPortfolio).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'agentChat', x: 0, y: 0, name: 'Puffin' },
  { id: 'n2', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
  { id: 'n3', kind: 'agentChat', x: 0, y: 0, name: 'Heron' },
]
const SECRET = 'my password is hunter2'

let f: Fixture
let unregister = (): void => undefined
let calls: unknown[][]
let failNext: { code: string; hint?: string } | null
const port: ChatPort = {
  snapshot: () => { throw new Error('not used') },
  tail: async () => [],
  async send(ws, id, text) { calls.push(['send', ws, id, text]); return failNext ? { ok: false, ...failNext } : { ok: true, started: id === 'n3' } },
  async configure(ws, id, patch) {
    calls.push(['configure', ws, id, patch])
    return failNext ? { ok: false, ...failNext } : { ok: true, config: { model: patch.model ?? null, effort: patch.effort ?? null, thinking: patch.thinking ?? true } }
  },
  async setMode(ws, id, mode) { calls.push(['setMode', ws, id, mode]); return failNext ? { ok: false, ...failNext } : { ok: true, permissionMode: mode } },
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); calls = []; failNext = null
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD } : null))
})
afterEach(() => { unregister(); f.close() })

function ctx(maxTier: Tier = 'R2', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createChatDefs({ chats: async () => port }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const run = (tool: string, input: Record<string, unknown>, c = ctx()) => execTool(c, tool, { projectId: 'p1', ...input })

describe('chat defs', () => {
  it('declares tiers, the read-tools flag and short summaries', async () => {
    const defs = createChatDefs({ chats: () => port })
    expect(defs.map((d) => [d.name, d.tier, d.flag])).toEqual([
      ['chat.send', 'R2', READ_TOOLS_FLAG], ['chat.config', 'R1', READ_TOOLS_FLAG], ['chat.mode', 'R2', READ_TOOLS_FLAG]])
    for (const d of defs) expect(d.summary.length, d.name).toBeLessThanOrEqual(120)
    expect(defs[0]!.auditKeys).not.toContain('text')
    expect(await run('chat.send', { nodeId: 'n1', text: 'hi' }, ctx('R1'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await run('chat.config', { nodeId: 'n1', model: 'sonnet' }, ctx('R1', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(calls).toEqual([])
  })
})

describe('chat.send', () => {
  it('sends to the chat by id or name and reports a started session', async () => {
    expect(await run('chat.send', { nodeId: 'n1', text: 'run the tests' })).toMatchObject({ ok: true, data: { sent: true, started: false, nodeId: 'n1', name: 'Puffin' } })
    expect(await run('chat.send', { nodeId: 'heron', text: 'line one\nline\ttwo' })).toMatchObject({ ok: true, data: { started: true, nodeId: 'n3' } })
    expect(calls).toEqual([['send', 'w-p1', 'n1', 'run the tests'], ['send', 'w-p1', 'n3', 'line one\nline\ttwo']])
  })

  it('rejects bad shapes before reaching the port', async () => {
    const bad = [{}, { nodeId: 'n1' }, { nodeId: 'n1', text: '' }, { nodeId: 'n1', text: 'x'.repeat(MAX_CHAT_TEXT + 1) },
      { nodeId: 'n1', text: 'a\x1b[2Jb' }, { nodeId: 'n1', text: 'hi', extra: 1 }, { nodeId: 'bad id!', text: 'hi' }]
    for (const input of bad) expect(await run('chat.send', input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(calls).toEqual([])
  })

  it('refuses unknown and non-chat nodes, pointing terminals to canvas.type', async () => {
    expect(await run('chat.send', { nodeId: 'Ghost', text: 'hi' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(await run('chat.send', { nodeId: 'Mango', text: 'hi' })).toMatchObject({ ok: false, code: 'not_a_chat', data: { kind: 'terminal', hint: expect.stringContaining('canvas.type') } })
    expect(await execTool(ctx(), 'chat.send', { projectId: 'p2', nodeId: 'n1', text: 'hi' })).toMatchObject({ ok: false, code: 'workspace_not_found' })
    expect(calls).toEqual([])
  })

  it('passes a port failure through and never puts the text in the output or the audit row', async () => {
    failNext = { code: 'chat_busy', hint: 'Wait for the reply.' }
    expect(await run('chat.send', { nodeId: 'n1', text: SECRET })).toMatchObject({ ok: false, code: 'chat_busy', data: { nodeId: 'n1', hint: 'Wait for the reply.' } })
    failNext = null
    const ok = await run('chat.send', { nodeId: 'n1', text: SECRET })
    expect(JSON.stringify(ok)).not.toContain('hunter2')
    const audit = allRows(f.db, 'SELECT payload_json FROM event').map((r) => JSON.parse(String(r['payload_json'])))
    expect(audit).toEqual([expect.objectContaining({ tool: 'chat.send', nodeId: 'n1', code: 'chat_busy' }), expect.objectContaining({ tool: 'chat.send', nodeId: 'n1', started: false })])
    expect(JSON.stringify(audit)).not.toContain('hunter2')
  })
})

describe('chat.config', () => {
  it('patches only the given fields; "default" means Auto (null)', async () => {
    expect(await run('chat.config', { nodeId: 'Puffin', model: 'sonnet' })).toMatchObject({ ok: true, data: { config: { model: 'sonnet' }, nodeId: 'n1' } })
    await run('chat.config', { nodeId: 'n1', model: 'default', effort: null, thinking: false })
    await run('chat.config', { nodeId: 'n1', effort: 'xhigh' })
    expect(calls).toEqual([
      ['configure', 'w-p1', 'n1', { model: 'sonnet' }],
      ['configure', 'w-p1', 'n1', { model: null, effort: null, thinking: false }],
      ['configure', 'w-p1', 'n1', { effort: 'xhigh' }],
    ])
  })

  it('rejects an empty patch and bad values', async () => {
    const bad = [{ nodeId: 'n1' }, { nodeId: 'n1', effort: 'huge' }, { nodeId: 'n1', model: '' }, { nodeId: 'n1', model: 'x'.repeat(201) },
      { nodeId: 'n1', thinking: 'yes' }, { nodeId: 'n1', model: 5 }, { nodeId: 'n1', model: 'opus', mode: 'plan' }]
    for (const input of bad) expect(await run('chat.config', input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(calls).toEqual([])
  })

  it('refuses a terminal and passes a port failure through', async () => {
    expect(await run('chat.config', { nodeId: 'n2', model: 'opus' })).toMatchObject({ ok: false, code: 'not_a_chat' })
    failNext = { code: 'config_failed', hint: 'Setting the model failed.' }
    expect(await run('chat.config', { nodeId: 'n1', model: 'opus' })).toMatchObject({ ok: false, code: 'config_failed', data: { hint: 'Setting the model failed.' } })
  })
})

describe('chat.mode', () => {
  it('switches to an allowed mode', async () => {
    expect(await run('chat.mode', { nodeId: 'Puffin', mode: 'plan' })).toMatchObject({ ok: true, data: { permissionMode: 'plan', nodeId: 'n1' } })
    expect(calls).toEqual([['setMode', 'w-p1', 'n1', 'plan']])
  })

  it('refuses bypassPermissions and unknown modes without calling the port', async () => {
    expect(await run('chat.mode', { nodeId: 'n1', mode: 'bypassPermissions' })).toMatchObject({
      ok: false, code: 'mode_refused', data: { hint: 'Only the user can turn on bypass permissions, from the node footer.' } })
    expect(await run('chat.mode', { nodeId: 'n1', mode: 'yolo' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await run('chat.mode', { nodeId: 'n1' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(calls).toEqual([])
  })

  it('passes a port failure through', async () => {
    failNext = { code: 'chat_not_found' }
    expect(await run('chat.mode', { nodeId: 'n1', mode: 'auto' })).toMatchObject({ ok: false, code: 'chat_not_found', data: { nodeId: 'n1' } })
  })
})
