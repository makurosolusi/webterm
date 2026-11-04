// Cost capture -> ledger, oracle median, ROI/cap auto-pause with an Inbox item, and the HTTP route,
// on the real ledger schema (bun:sqlite) and real transcript files under a temp CLAUDE_CONFIG_DIR.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgerDb } from '../ledger/migration'
import { registerWorkspaceLookup } from '../central/workspaceLookup'
import { readBudget, utcDay } from '../central/guard/budgetStore'
import { captureTranscript, syncCentralTurns } from './costCapture'
import { beginCostRun, costGate, endCostRun, estimateCost, listCaps, median, ROI_NO_DIFF_RUNS, setCostCap, type Notice } from './costOracle'
import { insertCostUsage, spendSummary, spentMicros } from './costStore'
import { costRoute, type CostResponse } from './cost.route'
import { recordPrefix } from '../central/context/promptPrefix'

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0) // test-only clock
const root = mkdtempSync(join(tmpdir(), 'cost-'))
const prevConfig = process.env.CLAUDE_CONFIG_DIR
const prevData = process.env.WEBTERM_DATA_DIR
process.env.CLAUDE_CONFIG_DIR = root
process.env.WEBTERM_DATA_DIR = join(root, 'data') // transcriptRoots() creates the data dir
const unregister = registerWorkspaceLookup((id) => (id === 'w1' ? { id: 'w1', name: 'Alpha', cwd: '/tmp/alpha' } : null))
afterAll(() => {
  unregister()
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfig
  if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevData
  rmSync(root, { recursive: true, force: true })
})

let db: Database
beforeEach(() => { db = openLedgerDb(':memory:') })

const all = (sql: string, ...p: unknown[]): Record<string, unknown>[] => db.query(sql).all(...(p as [])) as Record<string, unknown>[]
// test-only fixture line, shape of a Claude Code 2.x assistant entry
const line = (id: string, out: number, ts = T0): string => `${JSON.stringify({
  type: 'assistant', sessionId: 'sess-1', timestamp: new Date(ts).toISOString(),
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: out, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } },
})}\n`

function transcript(name: string, body: string): string {
  const dir = join(root, 'projects', '-tmp-alpha')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, body)
  return path
}

describe('captureTranscript', () => {
  test('records new responses once, reads incrementally, includes subagents and mirrors into the ledger usage table', () => {
    const path = transcript('s-a', line('msg_1', 100) + line('msg_1', 100) + line('msg_2', 50))
    mkdirSync(join(root, 'projects', '-tmp-alpha', 's-a', 'subagents'), { recursive: true })
    writeFileSync(join(root, 'projects', '-tmp-alpha', 's-a', 'subagents', 'agent-x.jsonl'), line('msg_sub', 10))
    const t = { path, nodeId: 'n1', workspaceId: 'w1' }
    expect(captureTranscript(db, t, () => T0)).toBe(3)
    expect(captureTranscript(db, t, () => T0)).toBe(0)
    appendFileSync(path, line('msg_3', 20) + '{"type":"assistant","message":{"usa') // half-written line is left for later
    expect(captureTranscript(db, t, () => T0)).toBe(1)

    // 1000*4 + 100*20 + 9000*0.2 = 7800 micros for msg_1
    const one = all("SELECT cost_micros, node_id, workspace_id, model FROM cost_usage WHERE key = 'cc:msg_1'")[0]
    expect(one).toEqual({ cost_micros: 7800, node_id: 'n1', workspace_id: 'w1', model: 'claude-opus-5-5' })
    const ledger = all("SELECT u.cache_read_tokens AS r, u.price_known AS k, run.model AS m, run.project_id AS p FROM usage u JOIN run ON run.id = u.run_id WHERE u.provider_response_id = 'cc:msg_1'")
    expect(ledger).toEqual([{ r: 9000, k: 1, m: 'claude-opus-5-5', p: 'w1' }])
    expect(all('SELECT COUNT(*) AS n FROM usage')[0]!['n']).toBe(4)
  })

  test('refuses a transcript outside the Claude/webterm roots', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cost-out-'))
    writeFileSync(join(outside, 'x.jsonl'), line('msg_9', 1))
    expect(captureTranscript(db, { path: join(outside, 'x.jsonl'), nodeId: 'n1', workspaceId: null })).toBe(0)
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('syncCentralTurns', () => {
  test('records each finished turn once and counts it in the guard daily budget', () => {
    db.query("INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','Alpha','/tmp/alpha',1,1)").run()
    const ins = db.query('INSERT INTO central_turn (id, conversation_id, message_id, status, runtime, usage_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    ins.run('t1', 'central:project:p1', 'm1', 'succeeded', 'claude', JSON.stringify({ inputTokens: 300, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, costMicros: 4200, durationMs: 900 }), T0, T0 + 1000)
    ins.run('t2', 'central:global', 'm2', 'succeeded', 'claude', JSON.stringify({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, durationMs: 1 }), T0, T0 + 2000)
    ins.run('t3', 'central:global', 'm3', 'running', 'claude', null, T0, null)
    expect(syncCentralTurns(db, () => T0)).toBe(2)
    expect(syncCentralTurns(db, () => T0)).toBe(0)
    const global = readBudget(db, utcDay(T0), 'global')
    expect(global).toMatchObject({ turns: 2, tokens: 515, costMicros: 4200 })
    expect(readBudget(db, utcDay(T0), 'project:p1')).toMatchObject({ turns: 1, tokens: 500 })
    expect(spentMicros(db, { since: 0, source: 'central' })).toEqual({ costMicros: 4200, unpriced: 1 })
  })
})

const usage = (key: string, nodeId: string, ts: number, cost: number): void => {
  insertCostUsage(db, { key, ts, source: 'agent', workspaceId: 'w1', nodeId, sessionId: null, model: 'claude-opus-5-5', input: 10, output: 10, cacheRead: 30, write5m: 0, write1h: 0, costMicros: cost })
}

describe('oracle', () => {
  test('median helper and estimate from the window cost of past runs of the same routine', () => {
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 10])).toBe(3)
    for (const [i, cost] of [100, 300, 200].entries()) {
      const start = T0 + i * 10_000
      const id = beginCostRun(db, { kind: 'routine', ref: 'tests-weekly', nodeId: 'n1', workspaceId: 'w1' }, () => start)
      usage(`u${i}`, 'n1', start + 5, cost)
      usage(`other${i}`, 'n2', start + 5, 9999) // another node in the same window is not this run
      endCostRun(db, id, { producedDiff: true }, () => start + 10, () => {})
    }
    expect(estimateCost(db, { kind: 'routine', ref: 'tests-weekly' })).toEqual({ medianMicros: 200, samples: 3, basis: 'ref' })
    expect(estimateCost(db, { kind: 'routine', ref: 'never-ran' })).toEqual({ medianMicros: 200, samples: 3, basis: 'kind' })
    expect(estimateCost(db, { kind: 'dag', ref: 'd1' })).toEqual({ medianMicros: null, samples: 0, basis: 'none' })
  })

  test(`${ROI_NO_DIFF_RUNS} runs in a row without a diff pause the routine and leave one Inbox notify`, () => {
    const notices: Notice[] = []
    let last = null as string | null
    for (let i = 0; i < ROI_NO_DIFF_RUNS; i++) {
      const id = beginCostRun(db, { kind: 'routine', ref: 'lint', nodeId: 'n1', workspaceId: 'w1' }, () => T0 + i * 100)
      last = endCostRun(db, id, { producedDiff: false }, () => T0 + i * 100 + 50, (_db, n) => notices.push(n)).paused
    }
    expect(last).toBe('routine:lint')
    expect(notices).toHaveLength(1)
    const gate = costGate(db, { kind: 'routine', ref: 'lint' }, () => T0 + 1000, () => {})
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('low ROI')
    // The default notifier writes a real inbox row.
    db.query('UPDATE cost_cap SET paused_at = NULL').run()
    const id = beginCostRun(db, { kind: 'routine', ref: 'lint', nodeId: 'n1', workspaceId: 'w1' }, () => T0 + 2000)
    endCostRun(db, id, { producedDiff: false }, () => T0 + 2050)
    expect(all("SELECT kind, source, title, workspace_id FROM inbox_item WHERE source = 'cost'")).toEqual([{ kind: 'notify', source: 'cost', title: 'Paused routine lint: low ROI', workspace_id: 'w1' }])
  })

  test('a used-up daily cap refuses new runs with an Inbox item; a routine cap counts its running window', () => {
    usage('big', 'n9', T0, 2_000_000)
    setCostCap(db, 'day', 1_000_000)
    const gate = costGate(db, { kind: 'dag', ref: 'd1', workspaceId: 'w1' }, () => T0 + 1)
    expect(gate.allowed).toBe(false)
    expect(all("SELECT title, body FROM inbox_item WHERE source = 'cost'")[0]).toMatchObject({ title: 'Cost cap reached: daily spend' })
    expect(costGate(db, { kind: 'dag', ref: 'd1' }, () => T0 + 86_400_000, () => {}).allowed).toBe(true) // next UTC day

    setCostCap(db, 'routine:docs', 500)
    beginCostRun(db, { kind: 'routine', ref: 'docs', nodeId: 'n3' }, () => T0 + 86_400_000)
    usage('docs1', 'n3', T0 + 86_400_000 + 10, 600)
    const later = () => T0 + 86_400_000 + 20
    expect(costGate(db, { kind: 'routine', ref: 'docs' }, later, () => {}).allowed).toBe(false)
    expect(listCaps(db, later()).find((c) => c.scope === 'routine:docs')).toMatchObject({ limitMicros: 500, spentMicros: 600, pausedAt: null })
  })
})

describe('costRoute', () => {
  const body = (v: unknown) => async () => JSON.stringify(v)
  const none = async () => ''
  test('summary for today and 7 days with cache hit rate, labels and the pricing source', async () => {
    usage('a', 'n1', T0, 1000)
    usage('b', 'n1', T0 - 3 * 86_400_000, 500)
    const res = await costRoute('/api/cost', 'GET', new URLSearchParams(), none, { db, now: T0, label: (k, id) => `${k}-${id}` })
    const out = res!.body as CostResponse
    expect(res!.status).toBe(200)
    expect(out.today.costMicros).toBe(1000)
    expect(out.week.costMicros).toBe(1500)
    expect(out.today.cacheHitRate).toBe(0.75)
    expect(out.labels['node:n1']).toBe('node-n1')
    expect(out.pricing.source).toContain('platform.claude.com')
    expect(out.prefix).toEqual({ prefixes: 0, hits: 0, reuseRate: null })
    recordPrefix(db, { projectId: null, text: 'sys', now: T0 })
    recordPrefix(db, { projectId: null, text: 'sys', now: T0 })
    recordPrefix(db, { projectId: null, text: 'sys', now: T0 })
    recordPrefix(db, { projectId: null, text: 'old', now: T0 - 30 * 86_400_000 })
    const again = (await costRoute('/api/cost', 'GET', new URLSearchParams(), none, { db, now: T0 }))!.body as CostResponse
    expect(again.prefix).toEqual({ prefixes: 1, hits: 2, reuseRate: 2 / 3 })
    expect(spendSummary(db, 0).byNode[0]).toMatchObject({ key: 'n1', costMicros: 1500, responses: 2 })
  })

  test('caps, resume, estimate validation, and ledger off', async () => {
    expect((await costRoute('/api/cost/caps', 'PUT', new URLSearchParams(), body({ scope: 'day', limitMicros: 5_000_000 }), { db }))!.status).toBe(200)
    expect(listCaps(db)[0]).toMatchObject({ scope: 'day', limitMicros: 5_000_000 })
    expect((await costRoute('/api/cost/caps', 'PUT', new URLSearchParams(), body({ scope: 'rm -rf', limitMicros: 1 }), { db }))!.status).toBe(400)
    expect((await costRoute('/api/cost/caps', 'PUT', new URLSearchParams(), body({ scope: 'day', limitMicros: -1 }), { db }))!.status).toBe(400)
    expect((await costRoute('/api/cost/resume', 'POST', new URLSearchParams(), body({ scope: 'routine:lint' }), { db }))!.status).toBe(200)
    expect((await costRoute('/api/cost/estimate', 'GET', new URLSearchParams('kind=routine&ref=x'), none, { db }))!.body).toEqual({ medianMicros: null, samples: 0, basis: 'none' })
    expect((await costRoute('/api/cost/estimate', 'GET', new URLSearchParams('kind=bad&ref=x'), none, { db }))!.status).toBe(400)
    expect((await costRoute('/api/cost', 'GET', new URLSearchParams(), none, { db: null }))!.status).toBe(503)
    expect(await costRoute('/api/costly', 'GET', new URLSearchParams(), none, { db })).toBeNull()
  })
})

describe('costRuntime', () => {
  test('a Stop hook on the event bus captures that node transcript; endCostRunLive captures before closing', async () => {
    const { eventBus } = await import('../events/eventBus')
    const rt = await import('./costRuntime')
    const path = transcript('s-live', line('msg_live', 10))
    await rt.startCostCapture({ db: () => db, transcriptOf: (id) => (id === 'n7' ? path : undefined) })
    try {
      eventBus.publish({ kind: 'hook.Stop', nodeId: 'n7', workspaceId: 'w1' } as Parameters<typeof eventBus.publish>[0])
      expect(all("SELECT node_id FROM cost_usage WHERE key = 'cc:msg_live'")).toEqual([{ node_id: 'n7' }])
      const id = await rt.beginCostRunLive({ kind: 'dag', ref: 'd9', nodeId: 'n7', workspaceId: 'w1' })
      appendFileSync(path, line('msg_live2', 10, Date.now()))
      const end = await rt.endCostRunLive(id, { producedDiff: true })
      expect(end?.costMicros).toBe(1000 * 4 + 10 * 20 + 9000 * 0.2)
      expect((await rt.costGateLive({ kind: 'dag', ref: 'd9' })).estimate.basis).toBe('ref')
    } finally {
      rt.stopCostCapture()
    }
  })
})
