// Templates end to end over the real route, a real in-memory webterm `app` table and a real ledger
// routine store; worktree creation is a recorder (the git side is covered by workspaceWorktree tests).
import { beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { IncomingMessage } from 'node:http'
import type { Workspace } from '../../shared/workspace'
import { migrate } from '../ledger/migration'
import { createRoutineStore } from '../routines/routineStore'
import { BUILTIN_TEMPLATES } from './template.builtins'
import { templatesRoute, type TemplatesDeps } from './template.route'
import { createTemplateStore } from './template.store'
import { substitute, validateTemplate, type WebtermTemplate } from './template.model'
import { registerClaudeLaunchSettings } from '../claudeLauncher/claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const ui = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8700', host: '127.0.0.1:8700' } // test-only
const HOSTILE = '$(rm -rf ~) `id` ; echo pwned\nsecond line {{repo}}'
const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV' // test-only fake key shape

let deps: TemplatesDeps
let workspaces: Map<string, Workspace>
let worktrees: Array<{ repo: string; title: string; branch?: string }>
let ledger: Database
let seq = 0

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = ui) {
  const req = { method, headers } as unknown as IncomingMessage
  return templatesRoute(req, new URL(path, 'http://x'), async () => (body === undefined ? '' : JSON.stringify(body)), deps)
}

beforeEach(() => {
  seq = 0
  workspaces = new Map()
  worktrees = []
  ledger = new Database(':memory:')
  migrate(ledger)
  const routineStore = createRoutineStore({ db: ledger, now: () => 1_000 })
  deps = {
    store: createTemplateStore(new Database(':memory:')),
    workspaces: {
      get: (id) => workspaces.get(id) ?? null,
      create: (name, cwd) => { const ws: Workspace = { id: `ws${++seq}`, name, cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 0 }; workspaces.set(ws.id, ws); return ws },
      save: (ws) => { workspaces.set(ws.id, ws); return 'saved' },
      delete: (id) => { workspaces.delete(id) },
    },
    routines: () => routineStore,
    worktreeRoot: '/wt',
    makeWorktree: async (input) => { worktrees.push(input); return { path: `/wt/repo/${input.branch ?? 'x'}`, branch: input.branch ?? 'x' } },
    isNodeToken: (t) => t === 'node-token',
    newId: () => `id${++seq}`,
    now: () => 1_700_000_000_000,
  }
})

function seedWorkspace(): Workspace {
  const ws: Workspace = {
    id: 'live', name: 'My board', cwd: '/home/me/repo', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
    nodes: [
      { id: 'a1', kind: 'agent', x: 10, y: 20, width: 600, height: 400, title: 'Claude', agentId: 'claude', cmd: `ANTHROPIC_API_KEY=${SECRET} claude --resume 1234-abcd`, sessionId: 'sess-uuid', cwd: '/home/me/repo', comments: [{ id: 'c', text: `use token=${SECRET}`, ts: 5, author: 'me' }] },
      { id: 'b1', kind: 'browser', x: 700, y: 20, url: 'https://app.example.com/dash?token=abc123#access_token=zzz', agentControl: true },
      { id: 'p1', kind: 'plan', x: 0, y: 500, plan: { intent: 'Ship it', dagId: 'dag-1', planId: 'plan-1', workspaceId: 'live' } },
      { id: 'w1', kind: 'agent', x: 700, y: 500, agentId: 'claude', cmd: 'claude', cwd: '/wt/repo/feature-x' },
    ],
    bridges: [{ id: 'e1', source: 'a1', target: 'b1', kind: 'context' }],
  }
  workspaces.set(ws.id, ws)
  return ws
}

test('save as template excludes secrets, sessions, tokens and per-machine paths', async () => {
  seedWorkspace()
  deps.routines()!.create({ name: 'Nightly', enabled: true, workspaceId: 'live', trigger: { type: 'schedule', cron: '0 2 * * *' }, precheck: null, action: { type: 'spawn', prompt: `check with ${SECRET}` }, budget: { maxRunsPerDay: 1, maxCostUsdPerDay: null } })
  const res = await call('POST', '/api/templates', { workspaceId: 'live', name: 'Board' })
  expect(res!.status).toBe(201)
  const t = (res as { body: { template: WebtermTemplate } }).body.template
  const text = JSON.stringify(t)
  for (const leaked of [SECRET, 'sess-uuid', '1234-abcd', 'abc123', 'access_token', 'dag-1', 'plan-1', '/home/me', 'agentControl', 'author']) expect(text).not.toContain(leaked)
  expect(t.nodes.map((n) => n.kind)).toEqual(['agent', 'browser', 'plan', 'agent'])
  expect(t.nodes[0].cmd).toBe('ANTHROPIC_API_KEY=[redacted] claude')
  expect(t.nodes[1].url).toBe('https://app.example.com/dash')
  expect(t.nodes[2].plan).toEqual({ intent: 'Ship it' })
  expect(t.nodes[3].worktree).toEqual({})
  expect([t.cwd, t.params.map((p) => p.id)]).toEqual(['{{repo}}', ['repo']])
  expect(t.cables).toEqual([{ from: 'n1', to: 'n2', kind: 'context' }])
  expect(t.routines).toHaveLength(1)
  expect(t.routines[0].action).toEqual({ type: 'spawn', prompt: 'check with [redacted]' })
  // Stored and listed after the built-ins.
  const list = (await call('GET', '/api/templates')) as { body: { templates: WebtermTemplate[] } }
  expect(list.body.templates.map((x) => x.id)).toEqual([...BUILTIN_TEMPLATES.map((b) => b.id), t.id])
})

test('round trip: save, export, import, instantiate into a new workspace', async () => {
  seedWorkspace()
  deps.routines()!.create({ name: 'Ping', enabled: true, workspaceId: 'live', trigger: { type: 'api' }, precheck: null, action: { type: 'spawn', prompt: 'ping' }, budget: { maxRunsPerDay: 1, maxCostUsdPerDay: null } })
  const saved = ((await call('POST', '/api/templates', { workspaceId: 'live', name: 'Board' })) as { body: { template: WebtermTemplate } }).body.template
  const exported = (await call('GET', `/api/templates/${saved.id}`)) as { status: number; body: WebtermTemplate }
  expect(exported.status).toBe(200)
  const file = JSON.parse(JSON.stringify(exported.body)) // what lands on disk and comes back
  const imported = (await call('POST', '/api/templates/import', file)) as { status: number; body: { template: WebtermTemplate } }
  expect(imported.status).toBe(201)
  expect(imported.body.template.id).not.toBe(saved.id) // same id -> stored as a copy
  expect({ ...imported.body.template, id: saved.id }).toEqual(saved)

  const inst = (await call('POST', `/api/templates/${imported.body.template.id}/instantiate`, { params: { repo: '/home/me/other' }, name: 'Copy' })) as { status: number; body: { workspace: Workspace; routines: { created: number } } }
  expect(inst.status).toBe(201)
  const ws = inst.body.workspace
  expect([ws.name, ws.cwd]).toEqual(['Copy', '/home/me/other'])
  expect(worktrees).toEqual([{ repo: '/home/me/other', title: 'n4' }]) // the captured worktree node gets its own
  expect(ws.nodes.map((n) => [n.kind, n.x, n.y])).toEqual([['agent', 10, 20], ['browser', 700, 20], ['plan', 0, 500], ['agent', 700, 500]])
  expect(ws.nodes.every((n) => !['a1', 'b1', 'p1', 'w1'].includes(n.id))).toBe(true) // fresh ids
  expect(ws.nodes.some((n) => n.sessionId)).toBe(false)
  expect(ws.bridges).toEqual([{ id: expect.any(String), source: ws.nodes[0].id, target: ws.nodes[1].id, kind: 'context' }])
  expect(ws.nodes[2].plan?.workspaceId).toBe(ws.id)
  expect(inst.body.routines.created).toBe(1)
  expect(deps.routines()!.list().filter((r) => r.workspaceId === ws.id).map((r) => r.enabled)).toEqual([false]) // paused for review
  expect((await call('DELETE', `/api/templates/${imported.body.template.id}`))!.status).toBe(204)
  expect((await call('GET', `/api/templates/${imported.body.template.id}`))!.status).toBe(404)
})

test('a hostile parameter value stays literal data and never reaches a command', async () => {
  const t = BUILTIN_TEMPLATES.find((b) => b.id === 'plan-worktree-workers')!
  const res = (await call('POST', `/api/templates/${t.id}/instantiate`, { params: { repo: '/home/me/repo', task: HOSTILE, branch: 'feat' } })) as { status: number; body: { workspace: Workspace } }
  expect(res.status).toBe(201)
  const nodes = res.body.workspace.nodes
  expect(nodes[0].plan?.intent).toBe(HOSTILE) // byte-for-byte, `{{repo}}` inside the value not expanded
  expect(nodes[1].comments?.[0].text).toBe(`Part of: ${HOSTILE}`)
  expect(nodes[1].cmd).toBe('claude')
  expect(nodes[2].cmd).toBe('claude')
  expect(worktrees.map((w) => w.branch)).toEqual(['feat-1', 'feat-2'])
  expect(nodes[1].cwd).toBe('/wt/repo/feat-1')
  // A hostile value in the cwd or branch is refused, and the half-made workspace is removed.
  const before = workspaces.size
  const bad = await call('POST', `/api/templates/${t.id}/instantiate`, { params: { repo: '/tmp/x\n$(id)', task: 't' } })
  expect(bad!.status).toBe(400)
  const badBranch = await call('POST', `/api/templates/${t.id}/instantiate`, { params: { repo: '/r', task: 't', branch: 'a\nb' } })
  expect(badBranch!.status).toBe(400)
  expect(workspaces.size).toBe(before)
  expect(substitute('{{a}}{{b}}', { a: '{{b}}', b: '`x`' })).toBe('{{b}}`x`')
})

test('a browser URL parameter cannot switch scheme', async () => {
  const res = await call('POST', '/api/templates/claude-browser-pair/instantiate', { params: { repo: '/r', url: 'javascript:alert(1)' } })
  expect(res!.status).toBe(400)
  const ok = (await call('POST', '/api/templates/claude-browser-pair/instantiate', { params: { repo: '/r', url: 'http://localhost:3000/a b' } })) as { body: { workspace: Workspace } }
  expect(ok.body.workspace.nodes[1].url).toBe('http://localhost:3000/a%20b')
})

test('bad imports are rejected with a reason', async () => {
  const base = validateTemplate(JSON.parse(JSON.stringify(BUILTIN_TEMPLATES[0])))
  const cases: Array<[string, unknown]> = [
    ['not an object', [1, 2]],
    ['wrong format', { ...base, format: 'other' }],
    ['parameter in a command', { ...base, id: 'x1', nodes: [{ ...base.nodes[0], cmd: 'claude "{{task}}"' }] }],
    ['multi-line command', { ...base, id: 'x2', nodes: [{ ...base.nodes[0], cmd: 'claude\nrm -rf ~' }] }],
    ['parameter in a precheck', { ...base, id: 'x3', routines: [{ name: 'r', trigger: { type: 'api' }, precheck: { command: 'echo {{task}}' }, action: { type: 'spawn', prompt: 'p' } }] }],
    ['undeclared parameter', { ...base, id: 'x4', nodes: [{ ...base.nodes[0], title: '{{nope}}' }] }],
    ['unknown kind', { ...base, id: 'x5', nodes: [{ ...base.nodes[0], kind: 'rootkit' }] }],
    ['dangling cable', { ...base, id: 'x6', cables: [{ from: 'agent', to: 'ghost' }] }],
  ]
  for (const [why, body] of cases) {
    const res = (await call('POST', '/api/templates/import', body)) as { status: number; body: { error: string } }
    expect([why, res.status]).toEqual([why, 400])
  }
  expect(deps.store.list()).toHaveLength(BUILTIN_TEMPLATES.length)
  const notJson = await templatesRoute({ method: 'POST', headers: ui } as unknown as IncomingMessage, new URL('/api/templates/import', 'http://x'), async () => '{not json', deps)
  expect(notJson!.status).toBe(400)
})

test('writes are human-UI only; built-ins are read-only', async () => {
  const agent = await call('POST', '/api/templates/import', BUILTIN_TEMPLATES[0], { ...ui, 'x-webterm-token': 'node-token' })
  expect(agent!.status).toBe(403)
  const curl = await call('POST', '/api/templates/claude-browser-pair/instantiate', {}, {})
  expect(curl!.status).toBe(403)
  expect((await call('DELETE', '/api/templates/pr-review-desk'))!.status).toBe(409)
})

test('instantiate into an existing workspace places nodes beside it and does not save the canvas', async () => {
  const ws = seedWorkspace()
  const before = JSON.stringify(ws)
  const res = (await call('POST', '/api/templates/pr-review-desk/instantiate', { workspaceId: 'live', params: { github: 'acme/app', pr: '42' } })) as { status: number; body: { nodes: Workspace['nodes']; routines: { created: number } } }
  expect(res.status).toBe(200)
  expect(JSON.stringify(workspaces.get('live'))).toBe(before) // the client owns the live canvas
  expect(res.body.nodes[0].x).toBe(700 + 0 + 80) // right of the widest existing node (browser at 700, no width)
  expect(res.body.nodes[0].cwd).toBe('/home/me/repo')
  expect(res.body.nodes[2].url).toBe('https://github.com/acme/app/pull/42')
  expect(res.body.routines.created).toBe(1)
})

test('claude template nodes record the default launch profile at instantiation; built-ins bake in no command', async () => {
  for (const t of BUILTIN_TEMPLATES) for (const n of t.nodes) if (n.agentId === 'claude') expect(n.cmd).toBe(undefined)
  registerClaudeLaunchSettings(() => ({ claudeLaunchProfiles: [{ id: 'm', name: 'M', command: 'envman -e claude:m --' }], defaultClaudeProfileId: 'm', centralClaudeProfileId: '' }))
  try {
    const res = (await call('POST', '/api/templates/plan-worktree-workers/instantiate', { params: { repo: '/r', task: 't' } })) as { body: { workspace: Workspace } }
    const agents = res.body.workspace.nodes.filter((n) => n.agentId === 'claude')
    expect(agents.map((n) => [n.claudeProfileId, n.cmd])).toEqual([['m', 'envman -e claude:m -- claude'], ['m', 'envman -e claude:m -- claude']])
    // A template node with its own command keeps it and records no profile.
    const own = { format: 'webterm-template', version: 1, id: 'own-cmd', name: 'Own', nodes: [{ key: 'a', kind: 'agent', x: 0, y: 0, agentId: 'claude', cmd: 'my-claude --fast' }] }
    expect((await call('POST', '/api/templates/import', own))!.status).toBe(201)
    const mine = (await call('POST', '/api/templates/own-cmd/instantiate', {})) as { body: { workspace: Workspace } }
    expect(mine.body.workspace.nodes[0]).toMatchObject({ cmd: 'my-claude --fast' })
    expect(mine.body.workspace.nodes[0].claudeProfileId).toBe(undefined)
  } finally {
    registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  }
})
