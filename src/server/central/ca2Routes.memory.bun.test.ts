import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch, isCa2Path } from './ca2Routes'
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './context/rotationPolicy'
import { freshDb, rows, run, T0 } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike // test-only
const BASE = '/api/central'
const BOT_TOKEN = '123456789:AAabcdefghijklmnopqrstuvwxyz0123456789' // test-only
const AGENT = 'agent:n1' // test-only
let dir: string
let h: Ca2Handle

type Res = { status: number; body: Record<string, unknown> }
const call = (method: string, path: string, body: unknown = {}, actor?: string) => {
  const url = new URL(BASE + path, 'http://x')
  return ca2Dispatch(h, { method, path: url.pathname, query: url.searchParams, body: async () => body }, actor) as Promise<Res>
}
const items = async (q = '') => (await call('GET', `/memory${q}`)).body.items as Array<Record<string, unknown>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca2-mem-'))
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({ runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0, env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_MODEL: 'paid', WEBTERM_MEMORY_DIR: join(dir, 'memory') } })
  if (!booted) throw new Error('boot failed')
  h = booted
})
afterEach(() => { h.stop(); setActiveCa2(null); rmSync(dir, { recursive: true, force: true }) })

interface Mem { id: string; projectId?: string | null; scope?: string; kind?: string; trust?: string; status?: string; sourceKind?: string | null; sourceRef?: string | null; at?: number; body?: string; key?: string }
function memory(m: Mem): void {
  run(h.db, `INSERT INTO memory (id, project_id, scope, key, title, body, status, kind, trust, source_kind, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.id, m.projectId === undefined ? 'p1' : m.projectId, m.scope ?? 'central', m.key ?? `key-${m.id}`, `title ${m.id}`, m.body ?? `body ${m.id}`, m.status ?? 'claim', m.kind ?? 'fact', m.trust ?? 'agent', m.sourceKind ?? null, m.sourceRef ?? null, m.at ?? 1, m.at ?? 1)
}
const proposal = (id: string): void => memory({ id, sourceKind: 'consolidator', sourceRef: 'r', key: `consolidate.add.new.${id}` })
const rule = (id: string, trust = 'agent'): void => memory({ id, projectId: null, scope: 'user', kind: 'procedure', trust, sourceKind: 'agent' })

describe('paths', () => {
  it('owns its routes and nothing near them', () => {
    for (const p of ['/state', '/context', '/turns/t1/context', '/memory', '/memory/m1/confirm', '/memory/m1/forget']) expect(isCa2Path(BASE + p)).toBe(true)
    for (const p of ['/turns/t1', '/memory/m1', '/memory/m1/edit']) expect(isCa2Path(BASE + p)).toBe(false)
  })

  it('answers 405 on the wrong method', async () => {
    expect((await call('PUT', '/state')).status).toBe(405)
    expect((await call('POST', '/context')).status).toBe(405)
    expect((await call('POST', '/turns/t1/context')).status).toBe(405)
    expect((await call('GET', '/memory/m1/forget')).status).toBe(405)
  })
})

describe('GET /memory', () => {
  it('carries provenance, the project name and redacted text', async () => {
    memory({ id: 'm1', sourceKind: 'central', sourceRef: 'central:global', at: 5, body: `use ${BOT_TOKEN}` })
    const [row] = await items()
    expect(row).toMatchObject({ id: 'm1', status: 'claim', sourceKind: 'central', sourceRef: 'central:global', createdAt: 5, projectName: 'One' })
    expect(String(row?.value)).not.toContain(BOT_TOKEN)
  })

  it('a memory with no project or source reads as empty, not as text', async () => {
    memory({ id: 'm1', projectId: null })
    expect((await items())[0]).toMatchObject({ projectName: '', sourceKind: null, sourceRef: null })
  })

  it('hides superseded, forgotten and blackboard rows', async () => {
    memory({ id: 'a' })
    memory({ id: 'b', status: 'superseded' })
    memory({ id: 'c', status: 'quarantine' })
    memory({ id: 'd', scope: 'blackboard' })
    expect((await items()).map((i) => i.id)).toEqual(['a'])
  })

  it('filters by project and status, and refuses an unknown status', async () => {
    memory({ id: 'a', status: 'claim' })
    memory({ id: 'b', status: 'fact' })
    memory({ id: 'c', status: 'fact', projectId: null })
    expect((await items('?status=fact')).map((i) => i.id).sort()).toEqual(['b', 'c'])
    expect((await items('?projectId=p1')).map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect((await items('?projectId=p1&status=fact')).map((i) => i.id)).toEqual(['b'])
    expect((await call('GET', '/memory?status=quarantine')).status).toBe(400)
  })

  it('pages newest first and refuses a bad page', async () => {
    for (const n of [1, 2, 3]) memory({ id: `m${n}`, at: n })
    expect((await items('?limit=2')).map((i) => i.id)).toEqual(['m3', 'm2'])
    expect((await items('?limit=2&offset=2')).map((i) => i.id)).toEqual(['m1'])
    expect((await call('GET', '/memory?limit=0')).status).toBe(400)
  })
})

describe('POST /memory/:id/confirm and /forget', () => {
  const stored = (id: string) => rows(h.db, 'SELECT status, trust, body FROM memory WHERE id = ?', id)[0]

  it('confirms a suggested rule and a consolidator proposal into human facts', async () => {
    rule('rule')
    proposal('prop')
    for (const id of ['rule', 'prop']) {
      expect((await call('POST', `/memory/${id}/confirm`)).status).toBe(200)
      expect(stored(id)).toMatchObject({ status: 'fact', trust: 'human' })
    }
  })

  it('confirms a claim Central remembered into a human fact', async () => {
    memory({ id: 'central-claim', sourceKind: 'central' })
    expect(await call('POST', '/memory/central-claim/confirm')).toEqual({ status: 200, body: { ok: true } })
    expect(stored('central-claim')).toMatchObject({ status: 'fact', trust: 'human' })
    expect(rows(h.db, "SELECT memory_id FROM memory_event WHERE kind = 'memory.confirm'").map((r) => r.memory_id)).toEqual(['central-claim'])
  })

  it('refuses web content, an existing fact and a blackboard claim, leaving them as they are', async () => {
    rule('web', 'external')
    memory({ id: 'fact', status: 'fact', trust: 'human' })
    memory({ id: 'board', scope: 'blackboard', status: 'claim' })
    expect(await call('POST', '/memory/web/confirm')).toEqual({ status: 400, body: { error: 'untrusted_source' } })
    expect((await call('POST', '/memory/fact/confirm')).status).toBe(404)
    expect((await call('POST', '/memory/board/confirm')).status).toBe(404)
    expect(stored('web')).toMatchObject({ status: 'claim' })
    expect(stored('board')).toMatchObject({ status: 'claim', trust: 'agent' })
  })

  it('forget scrubs the text and leaves a tombstone, as Settings does', async () => {
    memory({ id: 'm1' })
    expect(await call('POST', '/memory/m1/forget')).toEqual({ status: 200, body: { ok: true } })
    expect(stored('m1')).toMatchObject({ status: 'quarantine', body: '[forgotten]' })
    expect(rows(h.db, 'SELECT memory_id FROM memory_tombstone').map((r) => r.memory_id)).toEqual(['m1'])
    expect(await items()).toEqual([])
  })

  it('404s an unknown id and 400s an undecodable one', async () => {
    expect((await call('POST', '/memory/nope/forget')).status).toBe(404)
    expect((await call('POST', '/memory/nope/confirm')).status).toBe(404)
    expect((await call('POST', '/memory/%E0%A4%A/forget')).status).toBe(400)
  })
})

describe('human only', () => {
  it('refuses every write from a non-human actor, and changes nothing', async () => {
    memory({ id: 'm1' })
    for (const [path, body] of [['/memory/m1/confirm', {}], ['/memory/m1/forget', {}], ['/state', { projectId: null, body: 'x', expectedVersion: 0 }]] as const) {
      expect(await call('POST', path, body, AGENT)).toEqual({ status: 403, body: { error: 'human_only' } })
    }
    expect(rows(h.db, "SELECT status FROM memory WHERE id = 'm1'")[0]).toMatchObject({ status: 'claim' })
    expect((await call('GET', '/state')).body).toEqual({ global: null, project: null })
  })
})

describe('working state', () => {
  it('refuses an unknown project and an oversized document', async () => {
    expect(await call('POST', '/state', { projectId: 'nope', body: 'x', expectedVersion: 0 })).toEqual({ status: 404, body: { error: 'project_not_found' } })
    expect(await call('POST', '/state', { projectId: null, body: 'x\n'.repeat(500), expectedVersion: 0 })).toEqual({ status: 400, body: { error: 'state_too_large' } })
  })

  it('reads null before anything is written, and validates a write', async () => {
    expect(await call('GET', '/state?projectId=p1')).toEqual({ status: 200, body: { global: null, project: null } })
    expect((await call('POST', '/state', { projectId: null, body: 7, expectedVersion: 0 })).status).toBe(400)
    expect((await call('POST', '/state', { projectId: null, body: 'x', expectedVersion: 'one' })).status).toBe(400)
    expect((await call('POST', '/state', { projectId: 5, body: 'x', expectedVersion: 0 })).status).toBe(400)
  })

  it('writes the global and a project document separately', async () => {
    expect((await call('POST', '/state', { projectId: null, body: 'global', expectedVersion: 0 })).status).toBe(200)
    expect((await call('POST', '/state', { projectId: 'p1', body: 'project', expectedVersion: 0 })).status).toBe(200)
    const both = (await call('GET', '/state?projectId=p1')).body
    expect(both).toMatchObject({ global: { body: 'global', version: 1, updatedAt: T0 }, project: { body: 'project', version: 1 } })
    expect((await call('GET', '/state')).body.project).toBeNull()
  })

  it('a stale version is a 409 and keeps the newer text', async () => {
    await call('POST', '/state', { projectId: null, body: 'first', expectedVersion: 0 })
    await call('POST', '/state', { projectId: null, body: 'second', expectedVersion: 1 })
    expect(await call('POST', '/state', { projectId: null, body: 'late', expectedVersion: 1 })).toEqual({ status: 409, body: { error: 'version_conflict' } })
    expect((await call('GET', '/state')).body.global).toMatchObject({ body: 'second', version: 2 })
  })
})

function turn(id: string, conv: string, over: { ctx?: number | null; status?: string; contextJson?: string | null; at?: number } = {}): void {
  run(h.db, `INSERT INTO central_turn (id, conversation_id, message_id, status, ctx_tokens, context_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, conv, `msg-${id}`, over.status ?? 'succeeded', over.ctx ?? null, over.contextJson ?? null, over.at ?? 1)
}
const compact = (conv: string, ts: number, payload: unknown): void => run(h.db, "INSERT INTO event (ts, actor, kind, payload_json, correlation_id) VALUES (?, 'central', 'central.compact', ?, ?)", ts, JSON.stringify(payload), conv)

describe('GET /context', () => {
  it('needs a conversation id', async () => {
    expect(await call('GET', '/context')).toEqual({ status: 400, body: { error: 'invalid_conversation' } })
  })

  it('is empty before the first finished turn', async () => {
    expect((await call('GET', '/context?conversationId=c1')).body).toEqual({ tokens: null, window: DEFAULT_CONTEXT_WINDOW_TOKENS, percent: null, lastCompaction: null })
  })

  it('reports the last measured size against the window', async () => {
    turn('t1', 'c1', { ctx: 10_000, at: 1 })
    turn('t2', 'c1', { ctx: 100_000, at: 2 })
    // The window is the model's (200K for a plain id), no longer a fixed 128K.
    expect((await call('GET', '/context?conversationId=c1')).body).toMatchObject({ tokens: 100_000, window: DEFAULT_CONTEXT_WINDOW_TOKENS, percent: 50 })
  })

  it('takes the newest compaction of this conversation only, redacted', async () => {
    compact('c1', 10, { trigger: 'auto', preTokens: 90_000, summaryChars: 3, summary: 'old' })
    compact('c1', 20, { trigger: 'manual', preTokens: 100_000, summaryChars: 3, summary: `keep ${BOT_TOKEN}` })
    compact('c2', 30, { trigger: 'auto', preTokens: 1, summaryChars: 3, summary: 'other' })
    const last = (await call('GET', '/context?conversationId=c1')).body.lastCompaction as Record<string, unknown>
    expect(last).toMatchObject({ at: 20, trigger: 'manual', preTokens: 100_000 })
    expect(String(last.summary).startsWith('keep ')).toBe(true)
    expect(String(last.summary)).not.toContain(BOT_TOKEN)
  })

  it('a compaction without a stored summary reads as null', async () => {
    compact('c1', 10, { trigger: 'auto', preTokens: 5, summaryChars: 0 })
    expect((await call('GET', '/context?conversationId=c1')).body.lastCompaction).toEqual({ at: 10, trigger: 'auto', preTokens: 5, summary: null })
  })
})

describe('GET /turns/:id/context', () => {
  const context = (memoryIds: string[]) => JSON.stringify({ memoryIds, checkpointId: 'cp1', headerHash: 'h', headerChars: 900, stateVersions: { global: 3, project: null } })

  it('lists the memories in the order they were used, with what was given', async () => {
    memory({ id: 'a', trust: 'human', status: 'fact' })
    memory({ id: 'b' })
    turn('t1', 'c1', { contextJson: context(['b', 'a']) })
    expect((await call('GET', '/turns/t1/context')).body).toEqual({
      memory: [{ id: 'b', title: 'title b', trust: 'agent', status: 'claim' }, { id: 'a', title: 'title a', trust: 'human', status: 'fact' }],
      checkpointId: 'cp1', headerChars: 900, stateVersions: { global: 3, project: null },
    })
  })

  it('drops an id that no longer exists and answers without one when none were used', async () => {
    memory({ id: 'a' })
    turn('t1', 'c1', { contextJson: context(['gone', 'a']) })
    turn('t2', 'c1', { contextJson: context([]) })
    expect(((await call('GET', '/turns/t1/context')).body.memory as Array<{ id: string }>).map((m) => m.id)).toEqual(['a'])
    expect((await call('GET', '/turns/t2/context')).body).toMatchObject({ memory: [], headerChars: 900 })
  })

  it('an old turn with no record is nulls and an empty list', async () => {
    turn('t1', 'c1')
    expect((await call('GET', '/turns/t1/context')).body).toEqual({ memory: [], checkpointId: null, headerChars: null, stateVersions: null })
  })

  it('404s an unknown turn', async () => {
    expect(await call('GET', '/turns/nope/context')).toEqual({ status: 404, body: { error: 'turn_not_found' } })
  })
})
