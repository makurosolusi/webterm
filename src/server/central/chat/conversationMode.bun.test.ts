// Bun-only (bun:sqlite). The Central skill-author MODE end to end on the server side: the create route stores and
// validates it, the ledger migration is idempotent, a turn hands the mode to the runtime with no steward context,
// and the MCP backend narrows the tool list and refuses every other tool (and any canvas skill) for that chat.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { centralChatRoute, type CentralChatDeps } from '../../centralChatApi'
import { openLedgerDb } from '../../ledger/migration'
import { applyV39 } from '../../ledger/ledgerSchemaV39'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import { callCentralTool, listCentralTools } from '../../mcp/mcp.central'
import { obj, S } from '../../capability/capability.schema'
import { getConversation, getOrCreateConversation, listConversationEvents } from '../conversationStore'
import { createControlGuard } from '../guard/controlGuard'
import { createSkillDefs, type SkillToolStore } from '../tools/defs/skill.defs'
import { createRegistry } from '../tools/toolRegistry'
import type { ToolDef } from '../tools/toolTypes'
import type { CentralRuntime, RuntimeResult, TurnInput } from '../runtime/centralRuntime'
import { MODE_TOOLS, SKILL_AUTHOR_PROMPT } from './conversationMode'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'
import { createChatConversation, listConversationSummaries } from './turnPersistence'

function setup(runtime: CentralRuntime) {
  const db = openLedgerDb(':memory:')
  const stream = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
  const service = new TurnService({ db, stream, runtime })
  const ledger = { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
  const deps: CentralChatDeps = { ledger, chatEnabled: true, centralEnabled: true, runtimeKind: 'mock', service, stream }
  return { db, service, deps }
}

async function call(deps: CentralChatDeps, path: string, method: string, body?: string) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  req.method = method
  req.headers = {}
  let payload = ''
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, write(c: string) { payload += c },
    end(c = '') { payload += c; this.writableEnded = true }, on() { return this }, flushHeaders() {},
  }
  await centralChatRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), deps)
  return { status: res.statusCode, json: (payload === '' ? {} : JSON.parse(payload)) as Record<string, unknown> }
}

/** Runtime that records what a turn was given and finishes at once. */
function capturing(): { runtime: CentralRuntime; inputs: TurnInput[] } {
  const inputs: TurnInput[] = []
  const runtime: CentralRuntime = {
    kind: 'claude',
    cancel: () => false,
    turn: async (input): Promise<RuntimeResult> => {
      inputs.push(input)
      return { turnId: input.turnId, outcome: 'success', text: 'ok', usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 }, sessionRef: null } as unknown as RuntimeResult
    },
  }
  return { runtime, inputs }
}

describe('create route', () => {
  const { deps } = setup(capturing().runtime)
  const create = (body?: string) => call(deps, '/api/central/conversations', 'POST', body)

  it('stores the mode and the target and lists them', async () => {
    const made = await create(JSON.stringify({ mode: 'skill-author', skillTarget: 'webterm-project-status' }))
    expect(made.status).toBe(201)
    expect(made.json['mode']).toBe('skill-author')
    expect(made.json['skillTarget']).toBe('webterm-project-status')
    const listed = await call(deps, '/api/central/conversations', 'GET')
    const row = (listed.json['items'] as { id: string; mode: string | null }[]).find((r) => r.id === made.json['id'])
    expect(row?.mode).toBe('skill-author')
  })

  it('an empty or {} body is an ordinary chat with no mode', async () => {
    for (const body of [undefined, '{}']) {
      const made = await create(body)
      expect(made.status).toBe(201)
      expect(made.json['mode']).toBe(null)
      expect(made.json['skillTarget']).toBe(null)
    }
  })

  const bad: [string, unknown][] = [
    ['unknown mode', { mode: 'steward' }],
    ['target without a mode', { skillTarget: 'webterm-x' }],
    ['target that is not a skill name', { mode: 'skill-author', skillTarget: '../etc/passwd' }],
    ['non-string mode', { mode: 7 }],
  ]
  for (const [name, body] of bad) {
    it(`refuses ${name} with 400 invalid_body`, async () => {
      const made = await create(JSON.stringify(body))
      expect(made.status).toBe(400)
      expect((made.json['error'] as { code: string }).code).toBe('invalid_body')
    })
  }

  it('refuses malformed JSON and a non-object body', async () => {
    expect((await create('{nope')).status).toBe(400)
    expect((await create('[]')).status).toBe(400)
  })
})

describe('migration v39', () => {
  it('adds both columns once, keeps existing rows ordinary, and is safe to re-run (temp DB)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mode-mig-'))
    try {
      const db = openLedgerDb(join(dir, 'ledger.db'))
      getOrCreateConversation(db, 'global', 1)
      db.exec('ALTER TABLE central_conversation DROP COLUMN skill_target')
      db.exec('ALTER TABLE central_conversation DROP COLUMN mode')
      applyV39(db)
      applyV39(db)
      const cols = (db.query('PRAGMA table_info(central_conversation)').all() as { name: string }[]).map((c) => c.name)
      expect(cols.filter((c) => c === 'mode' || c === 'skill_target')).toEqual(['mode', 'skill_target'])
      expect(getConversation(db, 'central:global')).toMatchObject({ mode: null, skillTarget: null })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a turn of a mode chat', () => {
  it('hands the mode and only its tools to the runtime, with no steward context or memory', async () => {
    const { runtime, inputs } = capturing()
    const { db, service } = setup(runtime)
    const chat = createChatConversation(db, undefined, { mode: 'skill-author', skillTarget: 'webterm-project-status' })
    await service.submit({ conversationId: chat.id, clientMessageId: 'm1', text: 'make a skill' }).done
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ mode: 'skill-author', skillTarget: 'webterm-project-status', tools: [...MODE_TOOLS['skill-author']] })
    // The prompt is the human text alone: no State header, capability map or playbook hint of the steward.
    expect(inputs[0]!.text).toBe('make a skill')
  })

  it('an ordinary chat carries no mode', async () => {
    const { runtime, inputs } = capturing()
    const { db, service } = setup(runtime)
    const chat = createChatConversation(db)
    await service.submit({ conversationId: chat.id, clientMessageId: 'm1', text: 'hello' }).done
    expect('mode' in inputs[0]!).toBe(false)
    expect(inputs[0]!.tools).not.toEqual([...MODE_TOOLS['skill-author']])
  })

  it('the role names the author job, the draft-only rule and the canvas hand-off', () => {
    expect(SKILL_AUTHOR_PROMPT).toContain('You are the Central skill author. Your ONLY job is to help the human design, write and edit CENTRAL skills')
    expect(SKILL_AUTHOR_PROMPT).toContain('explicit "go"')
    expect(SKILL_AUTHOR_PROMPT).toContain('Canvas skills')
    expect(SKILL_AUTHOR_PROMPT).toContain('DRAFT')
  })
})

describe('MCP backend narrowing', () => {
  const proposed: { name: string; audience: string }[] = []
  const store = {
    list: () => [], load: () => null,
    propose: (input: { name: string; audience: string }) => {
      proposed.push({ name: input.name, audience: input.audience })
      return { name: input.name, version: '1', status: 'pending_approval', origin: 'central', audience: input.audience }
    },
  } as unknown as SkillToolStore
  const peek: ToolDef = {
    name: 'test.peek', summary: 'test-only read', tier: 'R0', projectScoped: false, usage: '{}',
    input: obj({}), output: S.anyObj('answer'), validate: () => null, handler: () => ({ ok: true, data: { answer: 42 } }),
  }
  const registry = createRegistry()
  registry.register(peek)
  for (const def of createSkillDefs(() => store)) registry.register(def)
  const db = openLedgerDb(':memory:')
  const env = { WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_SKILL_PROPOSE: 'on' }
  const guard = createControlGuard({ db, now: Date.now, env })
  const c = { db, registry, env, guard }
  const author = createChatConversation(db, undefined, { mode: 'skill-author', skillTarget: null }).id
  const targeted = createChatConversation(db, undefined, { mode: 'skill-author', skillTarget: 'webterm-edit-me' }).id
  const plain = createChatConversation(db).id
  const names = (id: string): string[] => listCentralTools(c, id).map((t) => t.name).sort()
  const propose = (conv: string, args: Record<string, unknown>) =>
    callCentralTool(c, conv, 'skill_propose', { name: 'webterm-x', description: 'd', body: 'b', caps: [], ...args })

  it('lists only the skill tools in a skill-author chat, everything in an ordinary one', () => {
    expect(names(author)).toEqual(['skill_list', 'skill_load', 'skill_propose'])
    expect(names(plain)).toEqual(['skill_list', 'skill_load', 'skill_propose', 'test_peek'])
  })

  it('allows the three skill tools and denies any other tool with a clear receipt', async () => {
    expect((await callCentralTool(c, author, 'skill_list', {})).outcome).toBe('ok')
    const denied = await callCentralTool(c, author, 'test_peek', {})
    expect(denied).toMatchObject({ outcome: 'denied', detail: 'tool_not_allowed_in_mode' })
    // The same tool still works in an ordinary chat.
    expect((await callCentralTool(c, plain, 'test_peek', {})).outcome).toBe('ok')
  })

  it('forces audience central and refuses a canvas skill', async () => {
    const before = proposed.length
    expect((await propose(author, { audience: 'canvas' }))).toMatchObject({ outcome: 'denied', detail: 'audience_not_allowed' })
    expect(proposed.length).toBe(before)
    expect((await propose(author, {})).outcome).toBe('ok')
    expect((await propose(author, { audience: 'central' })).outcome).toBe('ok')
    expect(proposed.slice(before)).toEqual([{ name: 'webterm-x', audience: 'central' }, { name: 'webterm-x', audience: 'central' }])
  })

  it('an edit chat may propose only its target skill', async () => {
    expect(await propose(targeted, { name: 'webterm-other' })).toMatchObject({ outcome: 'denied', detail: 'skill_not_target' })
    expect((await propose(targeted, { name: 'webterm-edit-me' })).outcome).toBe('ok')
  })

  it('an ordinary chat is untouched: a canvas audience still reaches the store', async () => {
    const before = proposed.length
    await propose(plain, { audience: 'canvas' })
    expect(proposed.slice(before)).toEqual([{ name: 'webterm-x', audience: 'canvas' }])
  })

  it('the list shown to the UI keeps mode on every row', () => {
    expect(listConversationSummaries(db).items.filter((r) => r.mode === 'skill-author')).toHaveLength(2)
  })
})
