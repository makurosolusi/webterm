import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { PlanStore } from './orchestrator/plan'
import {
  MAX_API_BODY_BYTES,
  type ExtendedApiDeps,
  extendedApiRoute,
  parseJsonObject,
} from './extendedApi'
import { fakeReq, fakeRes, urlOf } from './extendedApi.testutil'
import { openFixture, seedPortfolio, type Fixture } from './central/centralTestFixture.testutil'

let fixture: Fixture
let runtime: LedgerRuntime

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  runtime = { db: fixture.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
})
afterEach(() => fixture.close())

async function hit(
  method: string,
  path: string,
  body: string,
  deps: ExtendedApiDeps = {},
  ledger: LedgerRuntime | null = runtime
): Promise<{ handled: boolean; status: number; json: unknown; headers: Record<string, string> }> {
  const { res, state } = fakeRes()
  const handled = await extendedApiRoute(fakeReq(method, path), res, urlOf(path), async () => body, ledger, deps)
  return { handled, status: state.status, json: state.json(), headers: state.headers }
}

const json = (value: unknown) => JSON.stringify(value)

describe('extended API mount', () => {
  it('leaves every other family to the existing chain', async () => {
    for (const path of ['/api/inbox', '/api/orchestrator/agents', '/api/memory', '/api/central']) {
      const result = await hit('GET', path, '')
      expect(result.handled).toBe(false)
    }
  })

  it('answers 413 for an oversized body before parsing it', async () => {
    const result = await hit(
      'POST',
      '/api/orchestrator/run',
      'x'.repeat(MAX_API_BODY_BYTES + 1),
      { orchestrator: { enabled: true } }
    )
    expect(result.handled).toBe(true)
    expect(result.status).toBe(413)
    expect(result.json).toEqual({ error: 'payload_too_large' })
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
