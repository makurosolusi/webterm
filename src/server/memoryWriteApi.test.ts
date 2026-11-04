// Rute tulis memory: `POST /api/memory/claim` + `/promote`. Uji kode status, pemetaan error, cap
// body 64 KiB, dan aturan M2: field otoritas di payload DIABAIKAN (aktor selalu human:api-root).
// DB memakai adapter `nodeSqlite` supaya suite node-env tidak butuh `bun:sqlite`.
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { BodyReadError, cappedBodyGetter } from './cappedRequestBody'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import {
  MEMORY_API_AUTHORITY,
  MEMORY_WRITE_BODY_MAX_BYTES,
  memoryWriteRoute,
} from './memoryWriteApi'
import type { RouteResult } from './apiShared.types'
import { nodeSqlite } from './nodeSqlite.testutil'
import { normalizedTextHash } from './memory/memoryGuard'

const DDL = `
CREATE TABLE memory (
  id TEXT PRIMARY KEY, project_id TEXT, scope TEXT NOT NULL DEFAULT 'project',
  key TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claim',
  source_kind TEXT, source_ref TEXT, supersedes TEXT, superseded_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  -- v7/v18 columns the write path reads (trust for the poisoning guard, bi-temporal bookkeeping).
  trust TEXT NOT NULL DEFAULT 'agent', valid_from INTEGER, valid_to INTEGER, superseded_by TEXT,
  UNIQUE (project_id, scope, key)
);
CREATE TABLE memory_tombstone (
  text_hash TEXT NOT NULL, subject TEXT NOT NULL, memory_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (text_hash, subject)
);
CREATE TABLE memory_incognito (ref TEXT PRIMARY KEY, set_by TEXT NOT NULL, since INTEGER NOT NULL);
CREATE TABLE memory_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
  ts INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT
);
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, body, content='memory', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;`

type Raw = ReturnType<typeof nodeSqlite>

function fixture(): { runtime: LedgerRuntime; raw: Raw['raw'] } {
  const { db, raw } = nodeSqlite()
  raw.exec(DDL)
  return { runtime: { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime, raw }
}

function claimBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'p1',
    key: 'deploy',
    title: 'Deploy',
    body: 'deploy uses bun',
    sourceKind: 'file',
    sourceRef: 'README.md',
    ...overrides,
  }
}

function post(
  path: string,
  payload: unknown,
  runtime: LedgerRuntime | null = fixture().runtime
): Promise<RouteResult | null> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return memoryWriteRoute(path, 'POST', () => Promise.resolve(raw), runtime)
}

const ok = (result: RouteResult | null): NonNullable<RouteResult> => result as NonNullable<RouteResult>
const memoryOf = (result: RouteResult | null): Record<string, unknown> =>
  (ok(result).body as { memory: Record<string, unknown> }).memory

describe('POST /api/memory/claim', () => {
  it('creates a claim and audits it as the server-derived human actor', async () => {
    const { runtime, raw } = fixture()
    const result = ok(await post('/api/memory/claim', claimBody(), runtime))
    expect(result.status).toBe(201)
    expect(ok(result).body).toMatchObject({ ok: true })
    const memory = memoryOf(result)
    expect(memory).toMatchObject({
      projectId: 'p1',
      scope: 'project',
      key: 'deploy',
      status: 'claim',
      sourceKind: 'file',
      sourceRef: 'README.md',
    })
    const event = raw.prepare('SELECT actor, kind FROM memory_event').get() as {
      actor: string
      kind: string
    }
    expect(event).toEqual({ actor: MEMORY_API_AUTHORITY.id, kind: 'memory.claim' })
  })

  it('maps write-guard refusals to 400 memory_rejected with the reason, and masks PII', async () => {
    const { runtime, raw } = fixture()
    raw.prepare("INSERT INTO memory_tombstone VALUES (?, 'p1', NULL, 'human-ui', 1)").run(normalizedTextHash('deploy uses bun'))
    expect(await post('/api/memory/claim', claimBody(), runtime)).toEqual({ status: 400, body: { error: 'memory_rejected', reason: 'forgotten' } })
    raw.prepare("INSERT INTO memory_incognito VALUES ('README.md', 'human-ui', 1)").run()
    expect(await post('/api/memory/claim', claimBody({ key: 'k2', body: 'other text' }), runtime))
      .toEqual({ status: 400, body: { error: 'memory_rejected', reason: 'incognito' } })
    const masked = ok(await post('/api/memory/claim', claimBody({ key: 'k3', body: 'mail ops@corp.example', sourceRef: 'x' }), runtime))
    expect(memoryOf(masked).body).toBe('mail [email]')
    expect((raw.prepare('SELECT count(*) AS c FROM memory').get() as { c: number }).c).toBe(1)
  })

  it('ignores authority/actor/status injected in the payload', async () => {
    const { runtime, raw } = fixture()
    const result = ok(
      await post(
        '/api/memory/claim',
        claimBody({
          authority: { kind: 'worker', id: 'evil' },
          actor: 'worker',
          status: 'fact',
        }),
        runtime
      )
    )
    expect(result.status).toBe(201)
    expect(memoryOf(result).status).toBe('claim')
    const event = raw.prepare('SELECT actor, payload_json FROM memory_event').get() as {
      actor: string
      payload_json: string
    }
    expect(event.actor).toBe('api-root')
    expect(JSON.parse(event.payload_json).actorKind).toBe('human')
  })

  it('allows core scope for the human actor', async () => {
    const result = await post('/api/memory/claim', claimBody({ scope: 'core' }))
    expect(ok(result).status).toBe(201)
    expect(memoryOf(result).scope).toBe('core')
  })

  it('rejects an unknown scope as invalid_memory', async () => {
    const result = ok(await post('/api/memory/claim', claimBody({ scope: 'global' })))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'invalid_memory' })
  })

  it('rejects missing required fields as invalid_memory', async () => {
    const result = ok(await post('/api/memory/claim', { projectId: 'p1', key: 'k' }))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'invalid_memory' })
  })

  it('maps a duplicate (project, scope, key) to 409 memory_conflict', async () => {
    const { runtime } = fixture()
    expect(ok(await post('/api/memory/claim', claimBody(), runtime)).status).toBe(201)
    const duplicate = ok(await post('/api/memory/claim', claimBody(), runtime))
    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toEqual({ error: 'memory_conflict' })
  })
})

describe('POST /api/memory/promote', () => {
  const evidence = (): Record<string, unknown> => ({
    command: 'bun test src/server/memory',
    exitCode: 0,
    observedAt: Date.now(),
  })

  it('promotes a claim to fact with machine evidence', async () => {
    const { runtime, raw } = fixture()
    const claimed = memoryOf(ok(await post('/api/memory/claim', claimBody(), runtime)))
    const result = ok(
      await post('/api/memory/promote', { id: claimed.id, evidence: evidence() }, runtime)
    )
    expect(result.status).toBe(200)
    expect(memoryOf(result)).toMatchObject({ id: claimed.id, status: 'fact' })
    const kinds = raw.prepare('SELECT kind FROM memory_event ORDER BY seq').all() as {
      kind: string
    }[]
    expect(kinds.map((row) => row.kind)).toEqual(['memory.claim', 'memory.promote'])
  })

  it('rejects non-zero exit evidence as invalid_memory', async () => {
    const { runtime } = fixture()
    const claimed = memoryOf(ok(await post('/api/memory/claim', claimBody(), runtime)))
    const result = ok(
      await post(
        '/api/memory/promote',
        { id: claimed.id, evidence: { ...evidence(), exitCode: 1 } },
        runtime
      )
    )
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'invalid_memory' })
  })

  it('answers 404 memory_not_found for an unknown id', async () => {
    const result = ok(await post('/api/memory/promote', { id: 'nope', evidence: evidence() }))
    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: 'memory_not_found' })
  })

  it('maps promoting an already-fact row to 409 memory_conflict', async () => {
    const { runtime } = fixture()
    const claimed = memoryOf(ok(await post('/api/memory/claim', claimBody(), runtime)))
    await post('/api/memory/promote', { id: claimed.id, evidence: evidence() }, runtime)
    const again = ok(
      await post('/api/memory/promote', { id: claimed.id, evidence: evidence() }, runtime)
    )
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: 'memory_conflict' })
  })
})

describe('memory write route envelope', () => {
  it('answers 503 ledger_off without reading the body when the ledger is off', async () => {
    let reads = 0
    const result = await memoryWriteRoute(
      '/api/memory/claim',
      'POST',
      () => {
        reads += 1
        return Promise.resolve('{}')
      },
      null
    )
    expect(result).toEqual({ status: 503, body: { error: 'ledger_off' } })
    expect(reads).toBe(0)
  })

  it('returns null for other paths and for non-POST methods', async () => {
    const runtime = fixture().runtime
    const body = () => Promise.resolve('{}')
    expect(await memoryWriteRoute('/api/memory', 'GET', body, runtime)).toBe(null)
    expect(await memoryWriteRoute('/api/memory/claim', 'GET', body, runtime)).toBe(null)
    expect(await memoryWriteRoute('/api/memory/supersede', 'POST', body, runtime)).toBe(null)
  })

  it('maps unparsable or non-object JSON to 400', async () => {
    expect(ok(await post('/api/memory/claim', 'not json')).body).toEqual({ error: 'invalid_json' })
    expect(ok(await post('/api/memory/claim', '[]')).body).toEqual({ error: 'invalid_body' })
  })

  it('maps body-read rejections to 413 / 400', async () => {
    const runtime = fixture().runtime
    const tooLarge = await memoryWriteRoute(
      '/api/memory/claim',
      'POST',
      () => Promise.reject(new BodyReadError('too_large')),
      runtime
    )
    expect(tooLarge).toEqual({ status: 413, body: { error: 'payload_too_large' } })
    const failed = await memoryWriteRoute(
      '/api/memory/claim',
      'POST',
      () => Promise.reject(new BodyReadError('read_failed')),
      runtime
    )
    expect(failed).toEqual({ status: 400, body: { error: 'body_read_failed' } })
  })

  it('rejects a chunked body above the 64 KiB cap before the handler runs', async () => {
    const { runtime, raw } = fixture()
    const req = new EventEmitter() as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', headers: {}, resume: () => undefined })
    const oversize = JSON.stringify(claimBody({ body: 'x'.repeat(MEMORY_WRITE_BODY_MAX_BYTES) }))
    process.nextTick(() => {
      req.emit('data', Buffer.from(oversize))
      req.emit('end')
    })
    const result = await memoryWriteRoute(
      '/api/memory/claim',
      'POST',
      cappedBodyGetter(req, 'POST', MEMORY_WRITE_BODY_MAX_BYTES),
      runtime
    )
    expect(result).toEqual({ status: 413, body: { error: 'payload_too_large' } })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM memory').get()).toEqual({ n: 0 })
  })
})
