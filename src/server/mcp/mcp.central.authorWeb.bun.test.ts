// Bun-only (bun:sqlite). A Central skill-author chat may call browser_read and ONLY it from the browser family: the
// URL must be a public page, the model never picks the project or node, and every other browser tool stays denied.
import { describe, expect, it } from 'bun:test'
import { obj, S } from '../capability/capability.schema'
import { createChatConversation } from '../central/chat/turnPersistence'
import { createControlGuard } from '../central/guard/controlGuard'
import { createRegistry } from '../central/tools/toolRegistry'
import type { ToolDef } from '../central/tools/toolTypes'
import { openLedgerDb } from '../ledger/migration'
import { callCentralTool, listCentralTools } from './mcp.central'

const seen: Record<string, unknown>[] = []
const read: ToolDef = {
  name: 'browser_read', summary: 'test-only page reader', tier: 'R1', usage: '{}',
  input: obj({ url: S.str(2000), question: S.str(300), nodeId: S.str(200) }, ['url']), output: S.keys('answer', 'tainted'),
  validate: () => null, handler: (_ctx, input, projectId) => { seen.push({ ...input, projectId }); return { ok: true, data: { answer: 'page text', tainted: true } } },
}
const act: ToolDef = { name: 'browser_act', summary: 'test-only driver', tier: 'R2', usage: '{}', input: obj({}), output: S.anyObj('ok'), validate: () => null, handler: () => ({ ok: true, data: { ok: true } }) }

function setup(withProject: boolean) {
  const db = openLedgerDb(':memory:')
  if (withProject) db.exec("INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1', 'w1', 'p', '/tmp/p', 1, 1)")
  const registry = createRegistry()
  registry.register(read)
  registry.register(act)
  const env = {}
  const c = { db, registry, env, guard: createControlGuard({ db, now: Date.now, env }) }
  return { c, author: createChatConversation(db, undefined, { mode: 'skill-author', skillTarget: null }).id }
}

describe('skill-author browser_read', () => {
  it('lists browser_read without projectId and no other browser tool', () => {
    const { c, author } = setup(true)
    const tools = listCentralTools(c, author)
    expect(tools.map((t) => t.name)).toEqual(['browser_read'])
    expect(JSON.stringify(tools[0]!.inputSchema)).not.toContain('projectId')
  })

  it('reads a public page: server picks the project, the model-sent project and node are dropped', async () => {
    seen.length = 0
    const { c, author } = setup(true)
    const r = await callCentralTool(c, author, 'browser_read', { url: 'https://bulma.io/documentation/', question: 'buttons?', projectId: 'evil', nodeId: 'n1' })
    expect(r.outcome).toBe('ok')
    expect(seen).toEqual([{ url: 'https://bulma.io/documentation/', question: 'buttons?', projectId: 'p1' }])
  })

  it('refuses non-public urls before the tool runs', async () => {
    seen.length = 0
    const { c, author } = setup(true)
    for (const url of ['http://localhost:8700/', 'http://127.0.0.1/', 'http://10.0.0.5/x', 'https://user:pw@example.com/', 'file:///etc/passwd', 'http://169.254.169.254/latest']) {
      expect(await callCentralTool(c, author, 'browser_read', { url })).toMatchObject({ outcome: 'denied', detail: 'url_not_public' })
    }
    expect(seen).toEqual([])
  })

  it('denies browser_act and refuses cleanly when no project exists', async () => {
    const { c, author } = setup(false)
    expect(await callCentralTool(c, author, 'browser_act', {})).toMatchObject({ outcome: 'denied', detail: 'tool_not_allowed_in_mode' })
    expect(await callCentralTool(c, author, 'browser_read', { url: 'https://bulma.io/' })).toMatchObject({ outcome: 'denied', detail: 'no_project_for_web_read' })
  })
})
