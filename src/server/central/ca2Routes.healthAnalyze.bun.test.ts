import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ca2Handle } from './ca2Boot'
import { ca2Dispatch } from './ca2Routes'
import { freshDb, T0 } from './guard/controlGuard.testutil'
import { HEALTH_ANALYZE_COOLDOWN_MS, healthAnalyzerFor } from './health/healthAnalyze'

const PATH = '/api/central/health/analyze'

function rig() {
  const db = freshDb()
  const h = { db, now: () => T0 } as unknown as Ca2Handle
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  // Installed before any route touches the analyzer: no real Claude is ever started.
  const repo = mkdtempSync(join(tmpdir(), 'wt-analyze-route-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const analyzer = healthAnalyzerFor(db, h.now, {
    cwdOf: () => repo, globalRulesPath: null, book: () => undefined,
    run: async () => { await gate; return { output: { summary: '', findings: [] }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, model: null } } },
  })
  const call = (method: string, q = '', body: unknown = {}, actor = 'human:root') =>
    ca2Dispatch(h, { method, path: PATH, query: new URLSearchParams(q), body: async () => body }, actor)
  return { call, analyzer, release }
}

describe('health analyze route', () => {
  it('starts an analysis (202), refuses a second (409) and then the cooldown (429)', async () => {
    const r = rig()
    const started = await r.call('POST', '', { projectId: 'p1' })
    expect(started?.status).toBe(202)
    expect(started?.body).toMatchObject({ origin: 'analysis', status: 'running', projectId: 'p1' })
    expect(await r.call('POST', '', { projectId: 'p1' })).toEqual({ status: 409, body: { error: 'analysis_running' } })
    expect((await r.call('GET', 'projectId=p1'))?.body).toMatchObject({ running: true, scan: { status: 'running' } })
    r.release()
    while (r.analyzer.running('p1')) await new Promise((r) => setTimeout(r, 1))
    expect(await r.call('POST', '', { projectId: 'p1' })).toEqual({ status: 429, body: { error: 'cooldown', retryAt: T0 + HEALTH_ANALYZE_COOLDOWN_MS } })
    expect((await r.call('GET', 'projectId=p1'))?.body).toMatchObject({ running: false, retryAt: T0 + HEALTH_ANALYZE_COOLDOWN_MS, scan: { status: 'done' } })
  })

  it('validates the project and the actor', async () => {
    const r = rig()
    expect((await r.call('POST', '', { projectId: '../x' }))?.status).toBe(400)
    expect((await r.call('POST', '', { projectId: 'nope' }))?.status).toBe(404)
    expect((await r.call('GET', ''))?.status).toBe(400)
    expect((await r.call('POST', '', { projectId: 'p1' }, 'agent:x'))?.status).toBe(403)
    expect((await r.call('DELETE', 'projectId=p1'))?.status).toBe(405)
    expect((await r.call('GET', 'projectId=p1'))?.body).toEqual({ scan: null, running: false, retryAt: null, dropped: null })
  })
})
