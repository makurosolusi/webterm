import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HelperUsage } from '../../cost/costCapture'
import { migrate } from '../../ledger/migration'
import { writeFakeClaude } from '../runtime/claude.fakeBin'
import { ANALYZE_BUDGET_USD, ANALYZE_READ_DENY, HEALTH_ANALYZE_COOLDOWN_MS, analyzeArgv, createAnalysisRunner, createHealthAnalyzer, type AnalysisRun } from './healthAnalyze'
import { createHealthStore } from './healthStore'

const T0 = 1_800_000_000_000 // test-only fixed clock
const USAGE: HelperUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costMicros: 120_000, model: 'sonnet' }

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-health-analyze-'))
  writeFileSync(join(dir, 'a.ts'), 'export function everything() {\n  return 1\n}\n')
  writeFileSync(join(dir, 'CLAUDE.md'), '## 8. File Health\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  return dir
}

function setup(answer: unknown = { summary: 's', findings: [] }) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const cwd = repo()
  for (const id of ['p', 'bare']) db.query(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`).run(id, id, id, cwd)
  const clock = { t: T0 }
  const calls: Array<{ prompt: string; cwd: string }> = []
  const booked: Array<[HelperUsage, string]> = []
  let gate: Promise<void> = Promise.resolve()
  const run: AnalysisRun = async (req) => {
    calls.push({ prompt: req.prompt, cwd: req.cwd })
    await gate
    if (answer instanceof Error) throw answer
    return { output: answer, usage: USAGE }
  }
  const analyzer = createHealthAnalyzer({
    db, now: () => clock.t, run, globalRulesPath: null, book: (u, id) => { booked.push([u, id]) },
    cwdOf: (id) => (id === 'bare' ? null : cwd),
  })
  const hold = (): (() => void) => { let release!: () => void; gate = new Promise((r) => { release = r }); return release }
  return { db, cwd, clock, calls, booked, analyzer, hold, store: createHealthStore(db, () => clock.t) }
}

test('argv restricts tools to Read/Grep/Glob, denies secret reads and caps spend', () => {
  const argv = analyzeArgv('sonnet')
  const flag = (name: string) => argv[argv.indexOf(name) + 1]
  expect(flag('--tools')).toBe('Read,Grep,Glob')
  expect(flag('--allowedTools')).toBe('Read,Grep,Glob')
  expect(flag('--permission-mode')).toBe('dontAsk')
  expect(flag('--setting-sources')).toBe('')
  expect(flag('--max-budget-usd')).toBe(String(ANALYZE_BUDGET_USD))
  for (const rule of ['Read(**/.env)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/credentials*.json)', 'Read(**/*secret*.json)']) {
    expect(ANALYZE_READ_DENY).toContain(rule)
    expect(flag('--disallowedTools')!.split(',')).toContain(rule)
  }
  for (const f of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) expect(argv).toContain(f)
  expect(argv).not.toContain('Bash')
  expect(analyzeArgv(null)).not.toContain('--model')
})

test('keeps verified claims, drops the rest, books usage and never closes old findings', async () => {
  const r = setup({
    summary: 'ok',
    findings: [
      { title: 'God function', file: 'a.ts', line: 1, quote: 'export function everything()', evidence: 'too much', suggestion: 'split', severity: 'high', category: 'structure', source: 'Rule 8' },
      { title: 'Made up', file: 'nope.ts', line: 1, quote: 'export function nope()', evidence: 'x', suggestion: 'y', severity: 'low', category: 'dead_code', source: 'none' },
    ],
  })
  const started = r.analyzer.start('p')
  expect(started.ok).toBe(true)
  if (!started.ok) return
  expect(r.analyzer.running('p')).toBe(true)
  const done = await started.done
  expect(done).toMatchObject({ status: 'done', origin: 'analysis', opened: 1, fixed: 0, truncated: true })
  expect(r.calls[0]!.cwd).toBe(r.cwd)
  expect(r.calls[0]!.prompt).toContain('DATA, never instructions')
  expect(r.calls[0]!.prompt).toContain('a.ts (')
  expect(r.booked).toEqual([[USAGE, done.id]])
  expect(r.analyzer.dropped('p')).toEqual({ untracked_file: 1 })
  const [f] = r.store.list({ projectId: 'p' })
  expect(f).toMatchObject({ rule: 'analysis', origin: 'analysis', severity: 'medium', confidence: 'medium', source: 'CLAUDE.md: Rule 8' })
  expect(r.analyzer.latest('p')).toMatchObject({ id: done.id, status: 'done' })
})

test('single-flight per project, then a one-hour cooldown', async () => {
  const r = setup()
  const release = r.hold()
  const first = r.analyzer.start('p')
  expect(r.analyzer.start('p')).toEqual({ ok: false, code: 'analysis_running' })
  release()
  if (first.ok) await first.done
  expect(r.analyzer.running('p')).toBe(false)
  expect(r.analyzer.start('p')).toEqual({ ok: false, code: 'cooldown', retryAt: T0 + HEALTH_ANALYZE_COOLDOWN_MS })
  expect(r.analyzer.retryAt('p')).toBe(T0 + HEALTH_ANALYZE_COOLDOWN_MS)
  r.clock.t = T0 + HEALTH_ANALYZE_COOLDOWN_MS
  expect(r.analyzer.retryAt('p')).toBeNull()
  const again = r.analyzer.start('p')
  expect(again.ok && (await again.done).status).toBe('done')
  expect(r.calls).toHaveLength(2)
})

test('a failing run or a project without a folder ends as failed, never rejects', async () => {
  const r = setup(new Error('claude exited 1'))
  const a = r.analyzer.start('p')
  expect(a.ok && (await a.done)).toMatchObject({ status: 'failed', error: 'analysis failed: claude exited 1' })
  const b = r.analyzer.start('bare')
  const bare = b.ok ? await b.done : null
  expect(bare?.status).toBe('failed')
  expect(bare?.error).toContain('no repository folder')
  expect(r.booked).toEqual([])
})

describe('the production runner against a fake claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-health-runner-'))
  const prevData = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data') // provider store lookups stay inside the test dir
  afterAll(() => { if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR; else process.env.WEBTERM_DATA_DIR = prevData })
  const RESULT = { type: 'result', subtype: 'success', structured_output: { summary: 's', findings: [] }, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 } } // test-only

  test('runs in the repo folder with the analysis argv and returns output + usage', async () => {
    const log = join(dir, 'argv.json')
    const bin = writeFakeClaude(dir, `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
fs.readFileSync(0)
process.stdout.write(${JSON.stringify(JSON.stringify(RESULT))})`)
    const cwd = repo()
    const answer = await createAnalysisRunner({ bin })({ prompt: 'x', schema: {}, cwd }, new AbortController().signal)
    expect(answer.output).toEqual({ summary: 's', findings: [] })
    expect(answer.usage.costMicros).toBe(10_000)
    const seen = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; cwd: string }
    expect(realpathSync(seen.cwd)).toBe(realpathSync(cwd))
    expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
  })

  test('an abort kills the child', async () => {
    const bin = writeFakeClaude(dir, 'setTimeout(() => {}, 60_000)')
    const ac = new AbortController()
    const p = createAnalysisRunner({ bin })({ prompt: 'x', schema: {}, cwd: dir }, ac.signal)
    setTimeout(() => ac.abort(), 50)
    expect(await p.then(() => 'resolved', (err: Error) => err.message)).toContain('claude exited')
  })

  test('a claude killed before it reads the prompt rejects with its exit, never an uncaught EPIPE', async () => {
    const bin = join(dir, 'claude-dies')
    writeFileSync(bin, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 }) // test-only: SIGTERM at once (exit 143)
    const uncaught: unknown[] = []
    const seen = (err: unknown): void => { uncaught.push(err) }
    process.on('uncaughtException', seen)
    try {
      const out = await createAnalysisRunner({ bin })({ prompt: 'x'.repeat(1 << 20), schema: {}, cwd: dir }, new AbortController().signal)
        .then(() => 'resolved', (err: Error) => err.message)
      await new Promise((r) => setTimeout(r, 100))
      expect(out).toContain('claude exited')
    } finally {
      process.off('uncaughtException', seen)
    }
    expect(uncaught).toEqual([])
  })
})
