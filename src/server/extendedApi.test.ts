import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { PlanStore } from './orchestrator/plan'
import {
  MAX_API_BODY_BYTES,
  type ExtendedApiDeps,
  extendedApiRoute,
  parseJsonObject,
} from './extendedApi'
import { fakeRes, urlOf } from './extendedApi.testutil'
import { openFixture, seedPortfolio, type Fixture } from './central/centralTestFixture.testutil'

let fixture: Fixture
let runtime: LedgerRuntime

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  runtime = { db: fixture.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
})
afterEach(() => fixture.close())


interface StreamedReq extends IncomingMessage {
  resumed: boolean
}

/** Readable-ish request: emits `chunks` one turn apart, so a reader can abort mid-stream. */
function streamReq(
  method: string,
  path: string,
  chunks: string[],
  headers: Record<string, string> = {}
): StreamedReq {
  const req = new EventEmitter() as unknown as StreamedReq
  Object.assign(req, { method, url: path, headers, resumed: false, resume: () => { req.resumed = true } })
  let index = 0
  const pump = (): void => {
    if (index >= chunks.length) {
      req.emit('end')
      return
    }
    req.emit('data', Buffer.from(chunks[index] ?? ''))
    index += 1
    setImmediate(pump)
  }
  setImmediate(pump)
  return req
}

interface HitResult {
  handled: boolean
  status: number
  json: unknown
  headers: Record<string, string>
  req: StreamedReq
  /** Calls to the compatibility `readBody` parameter: must stay 0 on every extended path. */
  readBodyCalls: number
}

async function hitChunks(
  method: string,
  path: string,
  chunks: string[],
  headers: Record<string, string> = {},
  deps: ExtendedApiDeps = {},
  ledger: LedgerRuntime | null = runtime
): Promise<HitResult> {
  const { res, state } = fakeRes()
  const req = streamReq(method, path, chunks, headers)
  let readBodyCalls = 0
  const handled = await extendedApiRoute(
    req,
    res,
    urlOf(path),
    async () => {
      readBodyCalls += 1
      return chunks.join('')
    },
    ledger,
    deps
  )
  return { handled, status: state.status, json: state.json(), headers: state.headers, req, readBodyCalls }
}

async function hit(
  method: string,
  path: string,
  body: string,
  deps: ExtendedApiDeps = {},
  ledger: LedgerRuntime | null = runtime
): Promise<HitResult> {
  return hitChunks(method, path, body === '' ? [] : [body], {}, deps, ledger)
}

const json = (value: unknown) => JSON.stringify(value)

describe('extended API mount', () => {
  it('leaves every other family to the existing chain', async () => {
    for (const path of ['/api/inbox', '/api/orchestrator/agents', '/api/memory', '/api/central']) {
      const result = await hit('GET', path, '')
      expect(result.handled).toBe(false)
    }
  })

  it('answers 413 for an oversized chunked body without buffering it', async () => {
    const result = await hit(
      'POST',
      '/api/orchestrator/run',
      'x'.repeat(MAX_API_BODY_BYTES + 1),
      { orchestrator: { enabled: true } }
    )
    expect(result.handled).toBe(true)
    expect(result.status).toBe(413)
    expect(result.json).toEqual({ error: 'payload_too_large' })
    expect(result.readBodyCalls).toBe(0)
  })

  it('stops a chunked 1 MiB upload at MAX+1, drains, and never accumulates the rest', async () => {
    // 64 KiB chunks of a body with NO content-length: only the streaming cap can refuse this, and
    // the reader must detach (listenerCount 0) instead of keeping the remaining 1 MiB in memory.
    const chunk = 'y'.repeat(64 * 1024)
    const result = await hitChunks('POST', '/api/orchestrator/run', [chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk], {}, {
      orchestrator: { enabled: true },
    })
    expect(result.status).toBe(413)
    expect(result.json).toEqual({ error: 'payload_too_large' })
    expect(result.readBodyCalls).toBe(0)
    // The overflow path calls resume() and removes its listeners: nothing else is buffered.
    expect(result.req.resumed).toBe(true)
    expect(result.req.listenerCount('data')).toBe(0)
    expect(result.req.listenerCount('end')).toBe(0)
  })

  it('refuses a declared oversized content-length before reading a single chunk', async () => {
    const result = await hitChunks(
      'POST',
      '/api/memory/rebuild',
      [],
      { 'content-length': String(MAX_API_BODY_BYTES + 1) },
      { memory: { enabled: true } }
    )
    expect(result.status).toBe(413)
    expect(result.json).toEqual({ error: 'payload_too_large' })
    // Precheck path: the body was never read, and the socket is drained for keep-alive.
    expect(result.readBodyCalls).toBe(0)
    expect(result.req.resumed).toBe(true)
    expect(result.req.listenerCount('data')).toBe(0)
  })

  it('answers 400 for non-JSON objects', async () => {
    expect(parseJsonObject('[]').ok).toBe(false)
    expect(parseJsonObject('"x"').ok).toBe(false)
    expect(parseJsonObject('not json').ok).toBe(false)
    const result = await hit('POST', '/api/memory/export', 'not json', {
      memory: { enabled: true },
    })
    expect(result.status).toBe(400)
    expect(result.json).toEqual({ error: 'invalid_json' })
  })

  it('answers 503 when a surface flag is off, without reading a body contract', async () => {
    const orchestrator = await hit('POST', '/api/orchestrator/run', '{}', {
      orchestrator: { enabled: false },
    })
    expect(orchestrator.status).toBe(503)
    expect(orchestrator.json).toEqual({ error: 'orchestrator_off' })

    const memory = await hit('POST', '/api/memory/rebuild', '{}', { memory: { enabled: false } })
    expect(memory.status).toBe(503)
    expect(memory.json).toEqual({ error: 'memory_files_off' })
  })

  it('answers 405 for a non-POST run and sets a JSON content type', async () => {
    const result = await hit('GET', '/api/orchestrator/run', '', {
      orchestrator: { enabled: true },
    })
    expect(result.status).toBe(405)
    expect(result.json).toEqual({ error: 'method_not_allowed' })
    expect(result.headers['Content-Type']).toBe('application/json')
  })

  it('serves central reads and mutations through the same mount', async () => {
    const portfolio = await hit('GET', '/api/central/portfolio', '', {
      central: { enabled: true },
    })
    expect(portfolio.status).toBe(200)

    const paused = await hit('POST', '/api/central/projects/p1/pause', '', {
      central: { enabled: true },
    })
    expect(paused.status).toBe(200)
    expect(paused.json).toMatchObject({ changed: true, project: { status: 'paused' } })

    const unknown = await hit('GET', '/api/central/projects/p1/unknown', '', {
      central: { enabled: true },
    })
    expect(unknown.status).toBe(404)
    expect(unknown.json).toEqual({ error: 'unknown_route' })
  })

  it('dispatches orchestrator runs with the resolved ledger and returns the outcome', async () => {
    const plan: Pick<PlanStore, 'get'> = {
      get: () => ({
        id: 'pl1',
        projectId: 'p1',
        version: 1,
        status: 'active',
        items: [
          {
            id: 'i1',
            planId: 'pl1',
            seq: 0,
            taskId: 't1',
            title: 'x',
            scope: [],
            status: 'assigned',
            assignee: 'ag1',
            assignedAt: 1,
            updatedAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
    }
    let repo: string | undefined
    const result = await hit(
      'POST',
      '/api/orchestrator/run',
      json({ projectId: 'p1', itemId: 'i1', expectedVersion: 1 }),
      {
        orchestrator: {
          enabled: true,
          planStore: plan,
          dataDir: () => '/tmp/data',
          settings: () => ({ agentLaunchCommands: {} }),
          createRuntime: (compose) => {
            repo = compose.repo
            return {
              runTask: async () => ({
                ok: true,
                task: null,
                plan: null,
                nodeId: 'w-t1-1',
                output: 'done',
              }),
            }
          },
        },
      }
    )
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, outcome: { output: 'done' } })
    // p1 in the seeded fixture points at /tmp/p1; the client never supplies this.
    expect(repo).toBe('/tmp/p1')
  })
})
