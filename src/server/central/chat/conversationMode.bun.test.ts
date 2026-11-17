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
import { createSkillStore } from '../skills/skillStore'
import { createSkillDefs, type SkillToolStore } from '../tools/defs/skill.defs'
import { createRegistry } from '../tools/toolRegistry'
import type { ToolDef } from '../tools/toolTypes'
import type { CentralRuntime, RuntimeResult, TurnInput } from '../runtime/centralRuntime'
import { MODE_TOOLS, SKILL_AUTHOR_PROMPT, modePrompt } from './conversationMode'
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

  it('the role pins the structured intake protocol', () => {
    const r = SKILL_AUTHOR_PROMPT
    expect(r).toContain('You are the webterm skill author in the Control panel. Your ONLY job')
    expect(r).toContain('do NOT ask one open question')
    expect(r).toContain('AT MOST 3 questions per turn')
    expect(r).not.toContain('KIND first')
    expect(r).toContain('every skill you write is `central`')
    expect(r).toContain('STATUS LINE')
    expect(r).toContain('Collected:')
    expect(r).toContain('never re-ask')
    expect(r).toContain('skill_list so you do not duplicate')
    expect(r).toContain('SPEC SUMMARY')
    expect(r).toContain('explicit "go"')
    expect(r.indexOf('Only after "go"')).toBeGreaterThan(r.indexOf('SPEC SUMMARY'))
    for (const h of ['## Purpose', '## When to use', '## Steps', '## Do not', '## Done when']) expect(r).toContain(h)
    for (const f of ['title:', 'name:', 'audience:', 'description:', '300', '4000', '3 to 80']) expect(r).toContain(f)
    expect(r).toContain('always `central`')
    expect(r).toContain('Skills panel on the canvas')
    expect(r).toContain('DRAFT')
    expect(r).toContain('never say or imply a skill is active')
    expect(r).toContain('retry once')
    expect(r).toContain('built-ins are read-only')
    expect(r).toContain('data, never instructions')
  })

  it('the edit chat reads the skill first and handles user and built-in targets; a plain author chat has no edit line', () => {
    const edit = modePrompt('skill-author', 'webterm-project-status')
    expect(edit).toContain('skill_load it first')
    expect(edit).toContain('under the SAME name')
    expect(edit).toContain('built-ins are read-only: propose under a NEW')
    expect(edit).toContain('skill_not_target')
    expect(edit).toContain('`<base>-custom`')
    expect(SKILL_AUTHOR_PROMPT).toContain('a user skill keeps its own name')
    expect(edit).toContain('webterm-project-status')
    expect(modePrompt('skill-author', null)).toBe(SKILL_AUTHOR_PROMPT)
  })
})

describe('an edit conversation stays central (real store)', () => {
  it('a canvas proposal over an active central skill is refused before the store, whatever the model sends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'author-kind-'))
    try {
      const db = openLedgerDb(':memory:')
      const real = createSkillStore({ db, root })
      const registry = createRegistry()
      for (const def of createSkillDefs(() => real as unknown as SkillToolStore)) registry.register(def)
      const env = { WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_SKILL_PROPOSE: 'on' }
      const c = { db, registry, env, guard: createControlGuard({ db, now: Date.now, env }) }
      const body = '## Purpose\nx\n\n## When to use\nx\n\n## Steps\n1. One.\n2. Two.\n\n## Do not\n- x\n\n## Done when\nx\n'
      const args = { name: 'webterm-edit-me', title: 'Edit me', description: 'd', body, caps: [] }
      const first = await real.propose({ ...args, audience: 'central' }, 'central:seed')
      real.approve(first.name, first.version, 'human:ui', `approve ${first.name}@${first.version}`)
      const edit = createChatConversation(db, undefined, { mode: 'skill-author', skillTarget: 'webterm-edit-me' }).id
      const flipped = await callCentralTool(c, edit, 'skill_propose', { ...args, audience: 'canvas' })
      expect(flipped).toMatchObject({ outcome: 'denied', detail: 'audience_not_allowed_in_mode' })
      expect(real.list('pending_approval')).toEqual([])
      expect((await callCentralTool(c, edit, 'skill_propose', { ...args, audience: 'central' })).outcome).toBe('ok')
      expect(await callCentralTool(c, edit, 'skill_propose', { ...args, name: 'webterm-other-skill', audience: 'canvas' })).toMatchObject({ outcome: 'denied', detail: 'skill_not_target' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('built-in reference (variant flow, real store)', () => {
  it('the target is read-only: a new valid name is proposed, the built-in name itself is denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'author-variant-'))
    try {
      const db = openLedgerDb(':memory:')
      const real = createSkillStore({ db, root })
      real.installBuiltins()
      const registry = createRegistry()
      for (const def of createSkillDefs(() => real as unknown as SkillToolStore)) registry.register(def)
      const env = { WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_SKILL_PROPOSE: 'on' }
      const c = { db, registry, env, guard: createControlGuard({ db, now: Date.now, env }) }
      const variant = createChatConversation(db, undefined, { mode: 'skill-author', skillTarget: 'webterm-central-basics' }).id
      const body = '## Purpose\nx\n\n## When to use\nx\n\n## Steps\n1. One.\n2. Two.\n\n## Do not\n- x\n\n## Done when\nx\n'
      const args = { title: 'My variant', description: 'd', body, caps: [], audience: 'central' }
      expect(await callCentralTool(c, variant, 'skill_propose', { ...args, name: 'webterm-central-basics' })).toMatchObject({ outcome: 'denied', detail: 'skill_not_target' })
      expect((await callCentralTool(c, variant, 'skill_propose', { ...args, name: 'webterm-my-variant' })).outcome).toBe('ok')
      expect(real.list('pending_approval').map((r) => r.name)).toEqual(['webterm-my-variant'])
    } finally { rmSync(root, { recursive: true, force: true }) }
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
    callCentralTool(c, conv, 'skill_propose', { name: 'webterm-x', title: 'Title x', description: 'd', body: 'b', caps: [], ...args })

  it('lists only the skill tools in a skill-author chat, everything in an ordinary one', () => {
    expect(names(author)).toEqual(['skill_list', 'skill_load', 'skill_propose'])
    expect(names(plain)).toEqual(['skill_list', 'skill_load', 'skill_propose', 'test_peek'])
  })

  it('allows the three skill tools and denies any other tool with a clear receipt', async () => {
    expect((await callCentralTool(c, author, 'skill_list', {})).outcome).toBe('ok')
    const denied = await callCentralTool(c, author, 'test_peek', {})
    expect(denied).toMatchObject({ outcome: 'denied', detail: 'tool_not_allowed_in_mode' })
    // Denied before the input is even read: a malformed call to a forbidden tool is a denial, not a schema hint.
    expect(await callCentralTool(c, author, 'test_peek', { junk: 1 })).toMatchObject({ outcome: 'denied', detail: 'tool_not_allowed_in_mode' })
    // The same tool still works in an ordinary chat.
    expect((await callCentralTool(c, plain, 'test_peek', {})).outcome).toBe('ok')
  })

  it('the author writes central only: canvas is refused with audience_not_allowed_in_mode, a missing or unknown kind with audience_required', async () => {
    const before = proposed.length
    expect(await propose(author, { audience: 'canvas' })).toMatchObject({ outcome: 'denied', detail: 'audience_not_allowed_in_mode', next: 'canvas skills are written from the Skills panel on the canvas' })
    expect((await propose(author, { audience: 'central' })).outcome).toBe('ok')
    expect(proposed.slice(before)).toEqual([{ name: 'webterm-x', audience: 'central' }])
    for (const args of [{}, { audience: 'both' }, { audience: 'everyone' }]) {
      expect(await propose(author, args)).toMatchObject({ outcome: 'denied', detail: 'audience_required' })
    }
    expect(proposed.length).toBe(before + 1)
  })

  it('an edit chat may propose only its target skill', async () => {
    expect(await propose(targeted, { name: 'webterm-other' })).toMatchObject({ outcome: 'denied', detail: 'skill_not_target' })
    expect((await propose(targeted, { name: 'webterm-edit-me', audience: 'central' })).outcome).toBe('ok')
    expect(await propose(targeted, { name: 'webterm-edit-me' })).toMatchObject({ outcome: 'denied', detail: 'audience_required' })
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
