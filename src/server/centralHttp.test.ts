import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CENTRAL_HTTP_ACTOR,
  centralHttpRoute,
  isCentralPath,
} from './centralHttp'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { openFixture, seedPortfolio, type Fixture } from './central/centralTestFixture.testutil'

let fixture: Fixture
let runtime: LedgerRuntime

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  runtime = { db: fixture.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
})
afterEach(() => fixture.close())

function call(path: string, method = 'GET', body: unknown = undefined, enabled = true) {
  return centralHttpRoute(path, method, new URLSearchParams(), body, { runtime, enabled })
}

describe('central HTTP surface', () => {
  it('claims only exact central families', () => {
    expect(isCentralPath('/api/central/portfolio')).toBe(true)
    expect(isCentralPath('/api/central/projects/p1/pause')).toBe(true)
    expect(isCentralPath('/api/central')).toBe(false)
    expect(isCentralPath('/api/centralish/portfolio')).toBe(false)
    expect(call('/api/inbox')).toBeNull()
  })

  it('serves portfolio and one project read-only', () => {
    const portfolio = call('/api/central/portfolio')
    expect(portfolio?.status).toBe(200)

    const project = call('/api/central/projects/p1')
    expect(project?.status).toBe(200)
    expect(project?.body).toMatchObject({ id: 'p1' })
    expect(call('/api/central/projects/nope')?.status).toBe(404)
  })

  it('pauses and resumes through the fixed human/root guard', () => {
    expect(CENTRAL_HTTP_ACTOR).toEqual({ kind: 'human', id: 'root' })
    // A body that claims agent authority is ignored: the guard is not body-derived.
    const paused = call('/api/central/projects/p1/pause', 'POST', {
      actor: { kind: 'agent', id: 'bot' },
    })
    expect(paused?.status).toBe(200)
    expect(paused?.body).toMatchObject({ changed: true, project: { status: 'paused' } })

    const resumed = call('/api/central/projects/p1/resume', 'POST')
    expect(resumed?.status).toBe(200)
    expect(resumed?.body).toMatchObject({ changed: true, project: { status: 'active' } })

    const priority = call('/api/central/projects/p1/priority', 'POST', { priority: 42 })
    expect(priority?.status).toBe(200)
    expect(priority?.body).toMatchObject({ project: { priority: 42 } })
  })

  it('answers 503 while the flag or ledger is off', () => {
    expect(call('/api/central/portfolio', 'GET', undefined, false)).toEqual({
      status: 503,
      body: { error: 'central_off' },
    })
    expect(
      centralHttpRoute('/api/central/portfolio', 'GET', new URLSearchParams(), undefined, {
        runtime: null,
        enabled: true,
      })
    ).toEqual({ status: 503, body: { error: 'ledger_off' } })
  })

  it('rejects unsupported methods on a recognized path', () => {
    expect(call('/api/central/portfolio', 'POST')?.status).toBe(405)
    expect(call('/api/central/projects/p1', 'DELETE')?.status).toBe(405)
  })

  it('returns null for a malformed central subpath so api.ts can 404 it', () => {
    expect(call('/api/central/projects/p1/unknown')).toBeNull()
  })
})
