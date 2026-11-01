import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { centralRoute, type CentralRouteDeps, type RouteResult } from './centralApi'
import { centralEnabled, type CentralActor } from './centralModel'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { openFixture, seedPortfolio, type Fixture } from './centralTestFixture.testutil'

const human: CentralActor = { id: 'alice', kind: 'human' }
const agent: CentralActor = { id: 'bot', kind: 'agent' }

let fixture: Fixture
let runtime: LedgerRuntime

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  runtime = { db: fixture.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
})
afterEach(() => fixture.close())

function deps(overrides: Partial<CentralRouteDeps> = {}): CentralRouteDeps {
  return {
    runtime,
    enabled: true,
    authorize: () => human,
    ...overrides,
  }
}

function call(
  path: string,
  method = 'GET',
  query = '',
  body: unknown = undefined,
  d: CentralRouteDeps = deps()
): RouteResult | null {
  return centralRoute(path, method, new URLSearchParams(query), body, d)
}

function ok(...args: Parameters<typeof call>): RouteResult {
  const result = call(...args)
  expect(result).not.toBeNull()
  return result as RouteResult
}

describe('route matching and flags', () => {
  it('ignores paths outside the central surface', () => {
    expect(call('/api/inbox')).toBeNull()
    expect(call('/api/central')).toBeNull()
    expect(call('/api/central/portfolio/extra')).toBeNull()
    expect(call('/api/central/projects/p1/unknown')).toBeNull()
  })

  it('reads WEBTERM_CENTRAL only when it is exactly "on"', () => {
    expect(centralEnabled('on')).toBe(true)
    expect(centralEnabled(' ON ')).toBe(true)
    expect(centralEnabled('true')).toBe(false)
    expect(centralEnabled('1')).toBe(false)
    expect(centralEnabled(undefined)).toBe(false)
  })

  it('answers 503 when the flag is off, before any read or mutation', () => {
    const off = deps({ enabled: false })
    expect(ok('/api/central/portfolio', 'GET', '', undefined, off)).toEqual({
      status: 503,
      body: { error: 'central_off' },
    })
    expect(ok('/api/central/projects/p1/pause', 'POST', '', undefined, off).status).toBe(503)
  })

  it('answers 503 when the ledger runtime is missing', () => {
    const result = ok('/api/central/portfolio', 'GET', '', undefined, deps({ runtime: null }))
    expect(result).toEqual({ status: 503, body: { error: 'ledger_off' } })
  })

  it('rejects the wrong method for each exact route', () => {
    expect(ok('/api/central/portfolio', 'POST').status).toBe(405)
    expect(ok('/api/central/projects/p1', 'POST').status).toBe(405)
    expect(ok('/api/central/projects/p1/pause', 'GET').status).toBe(405)
  })
})

describe('read routes', () => {
  it('returns the portfolio page with paging', () => {
    const body = ok('/api/central/portfolio', 'GET', 'limit=2&offset=0').body as {
      items: { id: string }[]
      total: number
      limit: number
      offset: number
    }
    expect(body.total).toBe(3)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(0)
    expect(body.items.map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(body).not.toHaveProperty('runtime')
  })

  it('rejects malformed paging instead of coercing', () => {
    for (const query of ['limit=0', 'limit=1e3', 'limit=-1', 'limit=x', 'offset=-1', 'offset=1.5']) {
      const result = ok(`/api/central/portfolio`, 'GET', query)
      expect(result.status).toBe(400)
      expect(String((result.body as { error: string }).error)).toMatch(/^invalid_(limit|offset)$/)
    }
  })

  it('returns one project or 404', () => {
    const body = ok('/api/central/projects/p1').body as { id: string; name: string }
    expect(body).toMatchObject({ id: 'p1', name: 'Alpha' })
    expect(ok('/api/central/projects/missing')).toEqual({
      status: 404,
      body: { error: 'project_not_found' },
    })
  })
})

describe('mutation authority', () => {
  it('denies when the caller supplies no guard', () => {
    const result = ok('/api/central/projects/p1/pause', 'POST', '', undefined, deps({ authorize: undefined }))
    expect(result.status).toBe(403)
  })

  it('denies null, throwing, and agent guards', () => {
    expect(ok('/api/central/projects/p1/pause', 'POST', '', undefined, deps({ authorize: () => null })).status).toBe(403)
    expect(
      ok('/api/central/projects/p1/pause', 'POST', '', undefined, deps({
        authorize: () => {
          throw new Error('nope')
        },
      })).status
    ).toBe(403)
    expect(
      ok('/api/central/projects/p1/pause', 'POST', '', undefined, deps({ authorize: () => agent })).status
    ).toBe(403)
  })

  it('pauses, resumes, and reprioritizes for a human guard', () => {
    const paused = ok('/api/central/projects/p1/pause', 'POST').body as { project: { status: string } }
    expect(paused.project.status).toBe('paused')
    const resumed = ok('/api/central/projects/p1/resume', 'POST').body as { project: { status: string } }
    expect(resumed.project.status).toBe('active')

    const priority = ok('/api/central/projects/p1/priority', 'POST', '', { priority: 1000 })
    expect((priority.body as { project: { priority: number } }).project.priority).toBe(100)
  })

  it('validates the priority body', () => {
    for (const body of [{}, { priority: '10' }, { priority: 1.5 }, null, 'x']) {
      const result = ok('/api/central/projects/p1/priority', 'POST', '', body)
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error: 'invalid_priority' })
    }
  })

  it('returns 404 for a mutation on an unknown project', () => {
    const result = ok('/api/central/projects/missing/pause', 'POST')
    expect(result).toEqual({ status: 404, body: { error: 'project_not_found' } })
  })
})
