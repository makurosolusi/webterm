import { TEST_UI_COOKIE } from '../uiSession.testutil'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import type { AppendEventInput } from '../events/eventModel'
import type { EnqueueInput } from '../outbox/outboxStore'
import { formatProblemsForAgent, parseEslintJson, parseTscLine, parseTscOutput, TscWatchMatcher } from './problems.parse'
import { problemsRoute } from './problems.route'
import { detectTools, ProblemsService, type WatchProcess } from './problems.service'

// test-only fixtures: `tsc --noEmit --watch --pretty false` output.
const TSC_WATCH = [
  '[9:01:02 AM] Starting compilation in watch mode...',
  '',
  "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  'src/b.ts(3,1): error TS2304: Cannot find name \'foo\'.',
  '',
  '[9:01:04 AM] Found 2 errors. Watching for file changes.',
  '',
].join('\n')
const TSC_FIXED = ['[9:02:00 AM] File change detected. Starting incremental compilation...', '[9:02:01 AM] Found 0 errors. Watching for file changes.', ''].join('\n')

const ESLINT = JSON.stringify([
  { filePath: '/w/src/a.ts', messages: [{ ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.", line: 4, column: 7 }], errorCount: 1, warningCount: 0 },
  { filePath: '/w/src/c.ts', messages: [{ ruleId: null, severity: 1, message: 'Unused eslint-disable directive.', line: 1, column: 1 }] },
  { filePath: '/w/src/ok.ts', messages: [] },
])

describe('problem matchers', () => {
  it('parses $tsc lines relative to cwd (both paren and dash forms)', () => {
    expect(parseTscLine("src/a.ts(12,5): error TS2322: Type 'string' is not assignable.", '/w')).toEqual({
      source: 'ts', file: '/w/src/a.ts', line: 12, column: 5, severity: 'error', code: 'TS2322', message: "Type 'string' is not assignable.",
    })
    expect(parseTscLine('/abs/x.ts:7:2 - warning TS6133: unused', '/w')).toMatchObject({ file: '/abs/x.ts', line: 7, column: 2, severity: 'warning' })
    expect(parseTscLine('Found 2 errors.', '/w')).toBeNull()
    expect(parseTscOutput(TSC_WATCH, '/w')).toHaveLength(2)
  })

  it('reports a watch cycle only at its end marker, even when split across chunks', () => {
    const m = new TscWatchMatcher('/w')
    expect(m.feed(TSC_WATCH.slice(0, 80))).toBeNull()
    expect(m.feed(TSC_WATCH.slice(80))?.map((p) => p.code)).toEqual(['TS2322', 'TS2304'])
    expect(m.feed(TSC_FIXED)).toEqual([])
  })

  it('parses eslint -f json and rejects non-JSON', () => {
    expect(parseEslintJson(ESLINT)).toEqual([
      { source: 'eslint', file: '/w/src/a.ts', line: 4, column: 7, severity: 'error', code: 'no-unused-vars', message: "'x' is defined but never used." },
      { source: 'eslint', file: '/w/src/c.ts', line: 1, column: 1, severity: 'warning', message: 'Unused eslint-disable directive.' },
    ])
    expect(() => parseEslintJson('Oops! Something went wrong')).toThrow()
  })

  it('formats a capped list for the agent', () => {
    const ps = parseTscOutput(TSC_WATCH, '/w')
    expect(formatProblemsForAgent(ps, '/w', 10_000)).toContain('- src/a.ts:12:5 error TS2322:')
    const short = formatProblemsForAgent(ps, '/w', 200)
    expect(short.length).toBeLessThanOrEqual(200)
    expect(short).toContain('more not shown')
  })
})

function fakeDeps(files: string[]) {
  const events: AppendEventInput[] = []
  const procs: Array<{ out: (s: string) => void; killed: boolean; args: string[] }> = []
  const deps = {
    exists: (p: string) => files.includes(p),
    record: (e: AppendEventInput) => events.push(e),
    exec: async () => ESLINT,
    spawn: (_bin: string, args: string[]): WatchProcess => {
      const rec = { out: (_: string) => {}, killed: false, args }
      procs.push(rec)
      return { onStdout: (cb) => { rec.out = cb }, onExit: () => {}, kill: () => { rec.killed = true } }
    },
    now: () => 42,
  }
  return { deps, events, procs }
}

const ALL = ['/w/node_modules/.bin/tsc', '/w/tsconfig.json', '/w/node_modules/.bin/eslint']

describe('ProblemsService', () => {
  it('detects the workspace\'s own tools only', () => {
    expect(detectTools('/w', (p) => ALL.includes(p))).toEqual(['tsc', 'eslint'])
    expect(detectTools('/w', (p) => p === '/w/node_modules/.bin/tsc')).toEqual([]) // no tsconfig
  })

  it('merges tsc watch cycles with eslint, emits problems.updated with counts', async () => {
    const { deps, events, procs } = fakeDeps(ALL)
    const svc = new ProblemsService(deps)
    const s = await svc.run('ws1', '/w')
    expect(s).toMatchObject({ running: true, tools: ['tsc', 'eslint'], errors: 1, warnings: 1 })
    expect(procs[0]!.args).toEqual(['--noEmit', '--watch', '--pretty', 'false', '--preserveWatchOutput'])
    procs[0]!.out(TSC_WATCH)
    expect(svc.state('ws1')).toMatchObject({ errors: 3, warnings: 1 })
    expect(events.map((e) => [e.kind, (e.payload as { errors: number }).errors])).toEqual([['problems.updated', 1], ['problems.updated', 3]])
    await svc.run('ws1', '/w') // re-run: eslint again, tsc not spawned twice
    expect(procs).toHaveLength(1)
    svc.stop('ws1')
    expect(procs[0]!.killed).toBe(true)
    expect(svc.state('ws1').running).toBe(false)
  })

  it('reports an eslint crash instead of hiding it', async () => {
    const { deps } = fakeDeps(['/w/node_modules/.bin/eslint'])
    const svc = new ProblemsService({ ...deps, exec: async () => 'not json' })
    expect((await svc.run('ws1', '/w')).error).toMatch(/^eslint failed:/)
  })
})

const HOST = '127.0.0.1:8700'
const req = (method: string, headers: Record<string, string> = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }) =>
  ({ method, headers }) as unknown as IncomingMessage
const ws: Workspace = { id: 'ws1', name: 'w', cwd: '/w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 0 }

describe('problemsRoute', () => {
  function route() {
    const { deps } = fakeDeps(ALL)
    const svc = new ProblemsService(deps)
    const queued: EnqueueInput[] = []
    const rdeps = {
      service: async () => svc,
      workspace: async (id: string) => (id === 'ws1' ? ws : null),
      outbox: async () => ({ refusal: (to: string) => (to === 'agent1' ? null : 'not an agent'), enqueue: (i: EnqueueInput) => { queued.push(i); return { deduped: false } } }),
      isNodeToken: () => false,
    }
    const call = (method: string, path: string, body?: unknown, r = req(method)) =>
      problemsRoute(r, new URL(`http://${HOST}${path}`), async () => JSON.stringify(body), rdeps)
    return { call, queued }
  }

  it('refuses POSTs that are not the webterm page', async () => {
    const { call } = route()
    expect((await call('POST', '/api/problems/run', { workspace: 'ws1' }, req('POST', { host: HOST })))?.status).toBe(403)
  })

  it('runs, pages and sends the list to the agent through the outbox', async () => {
    const { call, queued } = route()
    expect((await call('POST', '/api/problems/fix', { workspace: 'ws1', to: 'agent1' }))?.status).toBe(409) // nothing yet
    expect((await call('POST', '/api/problems/run', { workspace: 'ws1' }))?.body).toMatchObject({ errors: 1 })
    expect((await call('GET', '/api/problems?workspace=ws1&limit=1'))?.body).toMatchObject({ total: 2, problems: [{ code: 'no-unused-vars' }] })
    expect((await call('POST', '/api/problems/fix', { workspace: 'ws1', to: 'nobody' }))?.status).toBe(404)
    expect((await call('POST', '/api/problems/fix', { workspace: 'ws1', to: 'agent1' }))?.status).toBe(202)
    expect(queued[0]).toMatchObject({ to: 'agent1', kind: 'visible', createdBy: 'human-ui', operationId: 'problems:ws1:42' })
    expect(queued[0]!.body).toContain('src/a.ts:4:7 error no-unused-vars')
    expect((await call('POST', '/api/problems/run', { workspace: 'nope' }))?.status).toBe(404)
    expect(await call('GET', '/api/other')).toBeNull()
  })
})
