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
import { captureTranscript, recordHelperUsage, syncCentralTurns } from './costCapture'
import { createClaudeStructured } from '../central/context/claudeStructured'
import { writeFakeClaude } from '../central/runtime/claude.fakeBin'
import { setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { bakeoffGate, beginCostRun, costGate, endCostRun, estimateCost, listCaps, median, ROI_NO_DIFF_RUNS, setCostCap, type Notice } from './costOracle'
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
    // Input-equivalent tokens: 300 + 200 + 50 cache reads at 0.1x = 505; + 15 for t2.
    expect(global).toMatchObject({ turns: 2, tokens: 520, costMicros: 4200 })
    expect(readBudget(db, utcDay(T0), 'project:p1')).toMatchObject({ turns: 1, tokens: 505 })
    expect(spentMicros(db, { since: 0, source: 'central' })).toEqual({ costMicros: 4200, unpriced: 1 })
  })
})

describe('syncCentralTurns: real model and cache-aware budget', () => {
  const ins = (id: string, usage: Record<string, unknown>, endedAt: number): void => {
    db.query('INSERT INTO central_turn (id, conversation_id, message_id, status, runtime, usage_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'central:global', `m-${id}`, 'succeeded', 'claude', JSON.stringify(usage), T0, endedAt)
  }

  test('stores the model id the runtime reported, priced from the table when the runtime had no estimate', () => {
    ins('r1', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, model: 'claude-sonnet-5-5' }, T0 + 1)
    ins('r2', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 9 }, T0 + 2)
    syncCentralTurns(db, () => T0)
    expect(all("SELECT key, model, cost_micros FROM cost_usage WHERE source = 'central' ORDER BY key")).toEqual([
      { key: 'central-turn:r1', model: 'claude-sonnet-5-5', cost_micros: 1000 * 2 + 100 * 10 },
      { key: 'central-turn:r2', model: 'central:claude', cost_micros: 9 },
    ])
  })

  test('a cache-heavy day no longer reads as a few thousand tokens', () => {
    // 2,000 in + 2,230 out + 10M cache reads + 100K writes, $2.28: before, the guard saw 4,230 tokens.
    ins('big', { inputTokens: 2000, outputTokens: 2230, cacheReadTokens: 10_000_000, cacheWriteTokens: 100_000, costMicros: 2_280_000 }, T0 + 1)
    syncCentralTurns(db, () => T0)
    expect(readBudget(db, utcDay(T0), 'global')).toMatchObject({ tokens: 4230 + 1_000_000 + 125_000, costMicros: 2_280_000 })
  })

  test('a helper row newer than an unsynced turn does not hide that turn', () => {
    recordHelperUsage(db, 'consolidator', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costMicros: 1, model: 'claude-haiku-5-5' }, { now: () => T0 + 500 })
    insertCostUsage(db, { key: 'consolidator:legacy', ts: T0 + 600, source: 'central', workspaceId: null, nodeId: null, sessionId: 'consolidator', model: null, input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0, costMicros: null })
    ins('late', { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 3 }, T0 + 100)
    expect(syncCentralTurns(db, () => T0)).toBe(1)
  })
})

describe('helper usage', () => {
  test('every helper kind books a priced row under source helper with the real model', () => {
    const kinds = ['classifier', 'checkpoint', 'handoff', 'brief', 'consolidator'] as const
    for (const k of kinds) recordHelperUsage(db, k, { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, costMicros: null, model: 'claude-haiku-5-5' }, { now: () => T0 })
    expect(all("SELECT session_id AS kind, model, cost_micros, price_known FROM cost_usage WHERE source = 'helper' ORDER BY session_id"))
      .toEqual([...kinds].sort().map((kind) => ({ kind, model: 'claude-haiku-5-5', cost_micros: 1000 * 0.1 + 100 * 0.5, price_known: 1 })))
    expect(spendSummary(db, 0).byModel[0]).toMatchObject({ key: 'claude-haiku-5-5', responses: 5 })
  })

  test('a real helper call books into the active ledger through the default path', async () => {
    const bin = writeFakeClaude(root, `readStdin()
process.stdout.write(${JSON.stringify(JSON.stringify({ subtype: 'success', structured_output: { a: [] }, total_cost_usd: 0.000123, usage: { input_tokens: 7, output_tokens: 3 }, modelUsage: { 'claude-haiku-5-5': { costUSD: 0.000123 } } }))})`)
    setActiveLedgerRuntime({ db } as never)
    try {
      await createClaudeStructured('checkpoint', { bin })({ prompt: 'x', schema: {} }, new AbortController().signal)
    } finally { setActiveLedgerRuntime(null) }
    expect(all("SELECT session_id, model, input, output, cost_micros FROM cost_usage WHERE source = 'helper'"))
      .toEqual([{ session_id: 'checkpoint', model: 'claude-haiku-5-5', input: 7, output: 3, cost_micros: 123 }])
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

  test('beginCostRun stores the ladder tier/model; estimateCost by tier falls back ref+tier -> kind+tier -> kind -> none', () => {
    const run = (ref: string, tier: 'T1' | 'T3' | null, cost: number, at: number): string => {
      const id = beginCostRun(db, { kind: 'dag', ref, nodeId: 'n1', tier, model: tier === 'T3' ? 'opus' : tier ? 'haiku' : null }, () => at)
      endCostRun(db, id, { producedDiff: true, costMicros: cost }, () => at + 1, () => {})
      return id
    }
    const first = run('d1', 'T3', 900, T0)
    run('d1', 'T1', 10, T0 + 10)
    run('d2', 'T3', 700, T0 + 20)
    run('d3', null, 50, T0 + 30)
    expect(all('SELECT tier, model FROM cost_run WHERE id = ?', first)).toEqual([{ tier: 'T3', model: 'opus' }])
    expect(estimateCost(db, { kind: 'dag', ref: 'd1', tier: 'T3' })).toEqual({ medianMicros: 900, samples: 1, basis: 'ref' })
    expect(estimateCost(db, { kind: 'dag', ref: 'd9', tier: 'T3' })).toEqual({ medianMicros: 800, samples: 2, basis: 'tier' })
    expect(estimateCost(db, { kind: 'dag', ref: 'd9', tier: 'T2' })).toEqual({ medianMicros: 375, samples: 4, basis: 'kind' })
    expect(estimateCost(db, { kind: 'dag', ref: 'd1' })).toEqual({ medianMicros: 455, samples: 2, basis: 'ref' })
    expect(estimateCost(db, { kind: 'routine', ref: 'x', tier: 'T3' })).toEqual({ medianMicros: null, samples: 0, basis: 'none' })
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

  test('bake-off candidates are runs: a reported cost counts toward the day cap once, and the gate needs N x the estimate', () => {
    const notices: Notice[] = []
    const keep = (_db: Database, n: Notice) => { notices.push(n) }
    // No cap: always open; no past candidates: no estimate.
    expect(bakeoffGate(db, { count: 3 }, () => T0, keep)).toMatchObject({ allowed: true, estimate: { medianMicros: null, basis: 'none' } })
    // Candidate 1: transcript captured 100k of a reported 300k; candidate 2: nothing captured, reported 500k.
    const a = beginCostRun(db, { kind: 'bakeoff', ref: 'b1', nodeId: 'bk-1' }, () => T0)
    usage('bk1', 'bk-1', T0 + 5, 100_000)
    expect(endCostRun(db, a, { costMicros: 300_000 }, () => T0 + 10, keep).costMicros).toBe(300_000)
    const b = beginCostRun(db, { kind: 'bakeoff', ref: 'b1', nodeId: 'bk-2' }, () => T0)
    endCostRun(db, b, { costMicros: 500_000 }, () => T0 + 10, keep)
    expect(all("SELECT kind, ref, cost_micros FROM cost_run WHERE kind = 'bakeoff' ORDER BY cost_micros")).toEqual([
      { kind: 'bakeoff', ref: 'b1', cost_micros: 300_000 }, { kind: 'bakeoff', ref: 'b1', cost_micros: 500_000 },
    ])
    expect(listCaps(db, T0 + 20)).toEqual([])
    setCostCap(db, 'day', 2_000_000)
    // Day spend = 100k captured + 200k + 500k uncaptured = 800k (not 900k: the captured part is not counted twice).
    expect(listCaps(db, T0 + 20).find((c) => c.scope === 'day')?.spentMicros).toBe(800_000)
    // Estimate per candidate = median(300k, 500k) = 400k. 3 x 400k fits in the 1.2M left; 4 x 400k does not.
    expect(bakeoffGate(db, { count: 3 }, () => T0 + 20, keep)).toMatchObject({ allowed: true, estimate: { medianMicros: 1_200_000, basis: 'kind' } })
    const over = bakeoffGate(db, { count: 4, workspaceId: 'w1' }, () => T0 + 20, keep)
    expect(over.allowed).toBe(false)
    expect(over.reason).toBe('A bake-off of 4 candidates is estimated at $1.60, but only $1.20 of the $2.00 daily cost cap remains. Use fewer candidates or raise the cap.')
    expect(notices.map((n) => n.title)).toEqual(['Bake-off refused: daily cost cap'])
    setCostCap(db, 'day', 800_000)
    expect(bakeoffGate(db, { count: 2 }, () => T0 + 20, keep).reason).toContain('Daily cost cap reached: spent $0.80 of $0.80')
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
