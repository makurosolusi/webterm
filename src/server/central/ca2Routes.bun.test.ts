import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch, isCa2Path } from './ca2Routes'
import { addAgent, freshDb, rows, run, T0 } from './guard/controlGuard.testutil'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { GOOD_BODY, GOOD_TITLE } from './skills/skillDraft.testutil'
import { confirmPhrase } from './skills/skillLifecycle'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'

const BOT_TOKEN = '123456789:AAEhBP0av28ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'
const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const SKILL = { name: 'webterm-demo', title: GOOD_TITLE, description: 'Summarize status. Use when asked.', body: GOOD_BODY, caps: ['portfolio.read'], audience: 'central' as const }
let dir: string
let h: Ca2Handle

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca2-routes-'))
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({
    runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0,
    env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose', WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_MEMORY: 'on', WEBTERM_CENTRAL_MODEL: 'vendor/model:free' },
  })
  if (!booted) throw new Error('boot failed')
  h = booted
})
afterEach(() => {
  h.stop()
  setActiveCa2(null)
  rmSync(dir, { recursive: true, force: true })
})

const call = (method: string, path: string, body: unknown = {}, actor?: string) =>
  ca2Dispatch(h, { method, path, query: new URL(path, 'http://x').searchParams, body: async () => body }, actor)
const get = (path: string) => ca2Dispatch(h, { method: 'GET', path: path.split('?')[0] ?? path, query: new URL(path, 'http://x').searchParams, body: async () => ({}) })

describe('path ownership', () => {
  it('claims only the panel paths', () => {
    for (const p of ['/api/central/status', '/api/central/agents', '/api/central/agents/a1/relay', '/api/central/skills/x/approve', '/api/central/memory', '/api/central/control', '/api/central/halt']) expect(isCa2Path(p)).toBe(true)
    for (const p of ['/api/central/conversations', '/api/central/health', '/api/central/agents/a1/other', '/api/inbox']) expect(isCa2Path(p)).toBe(false)
  })
  it('answers null for foreign paths and 405 for the wrong method', async () => {
    expect(await call('GET', '/api/central/conversations')).toBeNull()
    expect((await call('POST', '/api/central/status'))?.status).toBe(405)
  })
})

describe('status', () => {
  it('is the flat budget + model shape the panel parses', async () => {
    run(h.db, "INSERT INTO central_budget (day, scope, turns, tokens, cost_micros, spawns, wall_ms) VALUES ('2026-11-03','global',1,777,0,2,0)")
    const res = await get('/api/central/status')
    expect(res?.status).toBe(200)
    expect(res?.body).toMatchObject({ day: '2026-11-03', used: { tokens: 777, spawns: 2 }, model: { id: 'vendor/model:free', free: true } })
    // No daily token budget by default (0 = unlimited): the dollar cap is the budget.
    expect((res?.body as { limits: { tokens: number } }).limits.tokens).toBe(0)
  })
})

describe('approvals', () => {
  it('has no Central approvals view: the Central chat lists approvals (Needs-you strip)', async () => {
    expect(await get('/api/central/approvals')).toBeNull()
  })
})

describe('memory', () => {
  it('returns redacted rows and skips superseded ones', async () => {
    const ins = "INSERT INTO memory (id, project_id, scope, key, title, body, status, created_at, updated_at) VALUES (?, 'p1', 'project', ?, 't', ?, ?, 1, 2)"
    run(h.db, ins, 'm1', 'k1', `use ${BOT_TOKEN}`, 'claim')
    run(h.db, ins, 'm2', 'k2', 'old', 'superseded')
    const res = await get('/api/central/memory')
    const items = (res?.body as { items: Array<Record<string, string>> }).items
    expect(items.map((i) => i.id)).toEqual(['m1'])
    expect(items[0]).toMatchObject({ scope: 'project', key: 'k1' })
    expect(items[0]?.value).not.toContain(BOT_TOKEN)
    expect(items[0]?.trust).toBeTruthy()
  })
})

describe('agents', () => {
  it('lists agents, closes one, and 404s an unknown id', async () => {
    addAgent(h.db, 'a1', 'p1', 'working')
    const list = (await get('/api/central/agents'))?.body as { items: Array<Record<string, string>> }
    expect(list.items[0]).toMatchObject({ id: 'a1', projectId: 'p1', kind: 'opencode', runner: 'exec', state: 'working', owner: 'human' })
    expect((await call('POST', '/api/central/agents/a1/close'))?.status).toBe(200)
    expect(rows(h.db, "SELECT state FROM central_agents WHERE id = 'a1'")[0]?.state).toBe('killed')
    expect((await call('POST', '/api/central/agents/nope/close'))?.status).toBe(404)
  })

  it('relay validates the message and refuses a headless agent without crashing', async () => {
    addAgent(h.db, 'a2', 'p1', 'working')
    expect((await call('POST', '/api/central/agents/a2/relay', { message: '' }))?.status).toBe(400)
    const res = await call('POST', '/api/central/agents/a2/relay', { message: 'hello' })
    expect([200, 409]).toContain(res?.status)
    expect(res?.body).not.toEqual({ status: 'done' })
  })
})

describe('halt and control', () => {
  it('halt sets level off and force-closes live agents', async () => {
    addAgent(h.db, 'a3', 'p1', 'working')
    const halted = await call('POST', '/api/central/halt', { reason: 'test' })
    expect(halted).toMatchObject({ status: 200, body: { halted: true, level: 'off' } })
    expect(rows(h.db, "SELECT state FROM central_agents WHERE id = 'a3'")[0]?.state).toBe('killed')
    const control = (await get('/api/central/control'))?.body as { global: { level: string }; effective: string }
    expect(control.global.level).toBe('off')
    expect(control.effective).toBe('off')
  })
})

describe('skills admin', () => {
  const pend = () => h.skills?.propose(SKILL, 'central:c1')
  const approve = (version: string) => call('POST', `/api/central/skills/${SKILL.name}/approve`, { version, phrase: CONFIRM_PHRASE })
  const listed = async () => ((await get('/api/central/skills'))?.body as { items: Array<Record<string, any>> }).items

  it('lists the review queue with lint, diff and the confirm phrase', async () => {
    await pend()
    const items = (await listed()).filter((i) => i.record.status !== 'active')
    expect(items).toHaveLength(1)
    expect(items[0]?.record).toMatchObject({ name: SKILL.name, version: '1', status: 'pending_approval' })
    expect(items[0]?.lint).toMatchObject({ ok: true, findings: [] })
    expect(items[0]?.diff).toContain('Read the portfolio')
    expect(items[0]?.confirmPhrase).toBe(confirmPhrase(SKILL.name, '1'))
  })

  it('approve and rollback need a human actor; a central or worker actor gets 403 and changes nothing', async () => {
    await pend()
    for (const actor of ['central:c1', 'worker:w1', 'root']) {
      expect(await call('POST', `/api/central/skills/${SKILL.name}/approve`, { version: '1' }, actor)).toMatchObject({ status: 403, body: { error: 'human_only' } })
      expect((await call('POST', `/api/central/skills/${SKILL.name}/rollback`, {}, actor))?.status).toBe(403)
    }
    expect(h.skills?.list('pending_approval')).toHaveLength(1)
    expect(h.skills?.load(SKILL.name)).toBeNull()
  })

  it('diffs a new version against the active one, and is all-added for a first proposal', async () => {
    await pend()
    const first = ((await get('/api/central/skills'))?.body as { items: Array<{ diff: string }> }).items[0]?.diff ?? ''
    expect(first).toContain('+ 2. Write five lines.')
    expect(first.split('\n').filter((l) => l !== '' && !l.startsWith('+ '))).toEqual([])
    await approve('1')
    await h.skills?.propose({ ...SKILL, body: GOOD_BODY.replace('five', 'ten') }, 'central:c1')
    const diff = ((await get('/api/central/skills'))?.body as { items: Array<{ diff: string }> }).items[0]?.diff ?? ''
    expect(diff).toContain('- 2. Write five lines.')
    expect(diff).toContain('+ 2. Write ten lines.')
    expect(diff).toContain('  1. Read the portfolio.')
  })

  it('a human approve activates the skill; a bad version is a client error', async () => {
    await pend()
    expect((await call('POST', `/api/central/skills/${SKILL.name}/approve`, {}))?.status).toBe(400)
    expect((await approve('9'))?.status).toBe(404)
    expect(await approve('1')).toMatchObject({ status: 200, body: { status: 'done' } })
    expect(h.skills?.load(SKILL.name)?.record.approvedBy).toBe('human:root')
  })

  it('lists active skills beside open ones, builtin ones without rollback', async () => {
    await pend()
    const items = await listed()
    expect(items[0]?.record.status).toBe('pending_approval')
    const builtin = items.find((i) => i.record.origin === 'builtin')
    expect(builtin).toMatchObject({ record: { status: 'active' }, diff: '', canRollback: false, lint: { ok: true, findings: [] } })
  })

  it('offers rollback only when an earlier version exists', async () => {
    await pend()
    await approve('1')
    expect((await listed()).find((i) => i.record.name === SKILL.name)?.canRollback).toBe(false)
    await h.skills?.propose({ ...SKILL, body: GOOD_BODY.replace('five', 'ten') }, 'central:c1')
    await approve('2')
    expect((await listed()).find((i) => i.record.name === SKILL.name)).toMatchObject({ record: { version: '2' }, canRollback: true })
    expect((await call('POST', `/api/central/skills/${SKILL.name}/rollback`))?.status).toBe(200)
  })

  it('reject needs a human and a version, drops the row and frees the name', async () => {
    await pend()
    const reject = (body: unknown, actor?: string) => call('POST', `/api/central/skills/${SKILL.name}/reject`, body, actor)
    expect(await reject({ version: '1' }, 'central:c1')).toMatchObject({ status: 403, body: { error: 'human_only' } })
    expect(await reject({})).toMatchObject({ status: 400, body: { error: 'invalid_version' } })
    expect(await reject({ version: '9' })).toMatchObject({ status: 404 })
    expect(await reject({ version: '1' })).toEqual({ status: 200, body: { status: 'done' } })
    expect((await listed()).find((i) => i.record.name === SKILL.name)?.record).toMatchObject({ status: 'rejected', rejectReason: 'rejected_by_human' })
    expect((await h.skills?.propose(SKILL, 'central:c1'))?.version).toBe('2')
    expect(await reject({ version: '1' })).toMatchObject({ status: 403 })
  })

  it('a rejection by evaluation stays listed with its reason', async () => {
    await pend()
    run(h.db, "UPDATE central_skill SET status = 'rejected', reject_reason = 'evaluation did not pass (score 0.2)' WHERE name = ?", SKILL.name)
    expect((await listed()).find((i) => i.record.name === SKILL.name)?.record).toMatchObject({ status: 'rejected', rejectReason: 'evaluation did not pass (score 0.2)' })
  })

  it('?status=active lists the approved skills with their description (the Central chat / list)', async () => {
    await pend()
    const before = ((await get('/api/central/skills?status=active'))?.body as { items: unknown[] }).items
    expect(before.some((s) => (s as { name: string }).name === SKILL.name)).toBe(false)
    await approve('1')
    const items = ((await get('/api/central/skills?status=active'))?.body as { items: Array<{ name: string; description: string }> }).items
    expect(items.find((s) => s.name === SKILL.name)).toEqual({ name: SKILL.name, description: SKILL.description })
  })
})

describe('skill review policy', () => {
  it('proposing alone yields a version a human can approve', async () => {
    const rec = await h.skills?.propose(SKILL, 'central:c1')
    expect(rec?.status).toBe('pending_approval')
    expect(h.skills?.list('pending_approval').map((r) => r.name)).toEqual([SKILL.name])
  })

  it('the server refuses approve unless the body carries the typed phrase', async () => {
    await h.skills?.propose(SKILL, 'central:c1')
    run(h.db, "UPDATE central_skill SET status = 'pending_approval' WHERE name = ?", SKILL.name)
    for (const body of [{ version: '1' }, { version: '1', phrase: 'approve' }, { version: '1', phrase: confirmPhrase(SKILL.name, '1') }]) {
      expect(await call('POST', `/api/central/skills/${SKILL.name}/approve`, body)).toEqual({ status: 400, body: { error: 'confirm_phrase_mismatch' } })
    }
    expect(h.skills?.load(SKILL.name)).toBeNull()
  })
})

describe('a family whose feature is off answers 503 <feature>_off, not a fall-through 404', () => {
  it('agents and skills reads and actions answer a typed off code without their executor/store', async () => {
    const off = { ...h, executor: null, skills: null } as Ca2Handle
    const req = (method: string, path: string) => ({ method, path, query: new URLSearchParams(), body: async () => ({ message: 'hi', version: '1' }) })
    expect(await ca2Dispatch(off, req('GET', '/api/central/agents'))).toEqual({ status: 503, body: { error: 'agents_off' } })
    expect(await ca2Dispatch(off, req('GET', '/api/central/skills'))).toEqual({ status: 503, body: { error: 'skills_off' } })
    expect(await ca2Dispatch(off, { ...req('GET', '/api/central/skills'), query: new URLSearchParams('status=active') })).toEqual({ status: 503, body: { error: 'skills_off' } })
    expect(await ca2Dispatch(off, req('POST', '/api/central/agents/a1/relay'))).toEqual({ status: 503, body: { error: 'agents_off' } })
    expect(await ca2Dispatch(off, req('POST', '/api/central/agents/a1/close'))).toEqual({ status: 503, body: { error: 'agents_off' } })
    expect(await ca2Dispatch(off, req('POST', '/api/central/skills/x/approve'))).toEqual({ status: 503, body: { error: 'skills_off' } })
    expect(await ca2Dispatch(off, req('POST', '/api/central/skills/x/rollback'))).toEqual({ status: 503, body: { error: 'skills_off' } })
    expect(await ca2Dispatch(off, req('POST', '/api/central/skills/x/reject'))).toEqual({ status: 503, body: { error: 'skills_off' } })
    expect(await ca2Dispatch(off, req('POST', '/api/central/skills'))).toEqual({ status: 405, body: { error: 'method_not_allowed' } }) // the human create route is gone
    expect((await ca2Dispatch(off, req('PUT', '/api/central/skills')))?.status).toBe(405)
    for (const p of ['/api/central/status', '/api/central/memory', '/api/central/control']) expect((await ca2Dispatch(off, req('GET', p)))?.status).toBe(200)
  })
  it('with the feature on the same reads list as before', async () => {
    expect(await get('/api/central/agents')).toMatchObject({ status: 200, body: { items: expect.any(Array) } })
    expect(await get('/api/central/skills')).toMatchObject({ status: 200, body: { items: expect.any(Array) } })
  })
})
