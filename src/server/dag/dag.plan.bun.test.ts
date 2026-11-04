// Bun-only (real ledger): F4-f plan drafting. An intent becomes a draft with waves + estimate and NO dag
// row; only a human `POST /api/dag` creates it; agents get 403 on both; dispatches show in the dag view
// so the canvas can wire one worker node per dispatch. The planner is a fake: never a real Claude.
import { expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { freshDb, T0 } from '../central/guard/controlGuard.testutil'
import type { ExecOutcome } from '../central/agents/execRunner'
import { judgeCompletion } from '../verifier/verifier.judge'
import { SERVER_VERIFIED_BY } from '../orchestrator/orchestratorModel'
import { handleDagApi, type DagApiDeps } from './dag.api'
import type { Planner } from './dag.planner'
import { plannerArgv, plannerOutput } from './dag.planner'
import { createDagScheduler } from './dag.scheduler'

// test-only draft, as the planner's structured output would be
const draft = {
  title: 'Add login',
  tasks: [
    { key: 'api', kind: 'work', deps: [], brief: { objective: 'Add the endpoint', outputFormat: 'diff', tools: ['Read', 'Edit'], boundaries: 'api only', verifyCmd: { file: 'npm', args: ['test'] }, nextAction: 'ui', effort: 'simple', lease: ['src/api/**'] } },
    { key: 'ask', kind: 'gate', deps: ['api'], brief: { objective: 'Ship behind a flag?', nextAction: 'ui', options: ['yes', 'no'] } },
    { key: 'ui', kind: 'work', deps: ['ask'], brief: { objective: 'Add the form', outputFormat: 'diff', tools: ['Read', 'Edit'], boundaries: 'ui only', verifyCmd: { file: 'npm', args: ['test'] }, nextAction: 'done', effort: 'moderate', lease: ['src/ui/**'] } },
  ],
}

function setup(planner: Planner) {
  const db = freshDb()
  const ctx = { db, now: () => T0 }
  const intents: string[] = []
  const s = createDagScheduler({
    ctx, record: () => {}, workersEnabled: () => true, behind: async () => 0,
    allocate: async (_d, task, id) => ({ path: `/tmp/st/wt-${task.key}-${id}`, branch: `dag/${task.key}`, baseSha: 'a'.repeat(40) }),
    spawn: async (req) => ({ ok: true, childId: `node:${req.nodeId}`, nodeId: req.nodeId!, depth: 1, name: 'w', handle: { pid: 1, done: new Promise<ExecOutcome>(() => {}), tail: () => '', kill: () => {} } }),
    verify: async (i) => judgeCompletion({ taskId: i.taskId, verdict: { verifiedBy: SERVER_VERIFIED_BY, ok: true, reasons: [], changedFiles: [], scopeViolations: [], evidence: [], tests: { passed: 0, failed: 0, command: 'npm test' } } }),
    report: () => {}, openGate: () => 'approval-x',
  })
  const deps: DagApiDeps = {
    ctx, scheduler: s, isNodeToken: (t) => t === 'node-tok', record: () => {},
    planner: async (i) => { intents.push(i.intent); return planner(i) },
    workspace: (id) => (id === 'w9' ? { id, name: 'Nine', cwd: '/tmp/st/repo9' } : null),
  }
  const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: '127.0.0.1:8700', ...headers } }) as unknown as IncomingMessage
  const human = (method = 'POST') => req(method, { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8700' })
  const agent = req('POST', { 'x-webterm-token': 'node-tok', 'sec-fetch-site': 'same-origin' })
  const call = (r: IncomingMessage, path: string, body: Record<string, unknown> = {}) => handleDagApi(deps, r, new URL(`http://127.0.0.1:8700${path}`), body)
  const poll = async (planId: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await call(human('GET'), `/api/dag/plan/${planId}`)
      if ((r?.body as { status: string }).status !== 'drafting') return r!.body as Record<string, unknown>
      await new Promise((res) => setTimeout(res, 1))
    }
    throw new Error('draft never settled')
  }
  const dagCount = () => Number((db.query('SELECT COUNT(*) AS n FROM dag').get() as { n: number }).n)
  return { db, s, intents, call, human, agent, poll, dagCount }
}

test('an intent becomes a draft with waves, estimate and gates, and no dag exists until approval', async () => {
  const h = setup(async () => draft)
  const started = await h.call(h.human(), '/api/dag/plan', { intent: '  add a login form ', workspaceId: 'w9' })
  expect(started?.status).toBe(202)
  const job = await h.poll((started!.body as { planId: string }).planId)
  expect(job).toMatchObject({ status: 'ready', projectId: 'w9', repo: '/tmp/st/repo9', waves: [['api'], ['ask'], ['ui']] })
  expect(job.estimate).toMatchObject({ tasks: 2, basis: 'none', totalMicros: null })
  expect((job.draft as { tasks: { key: string; kind: string }[] }).tasks.map((t) => `${t.key}:${t.kind}`)).toEqual(['api:work', 'ask:gate', 'ui:work'])
  expect(h.intents).toEqual(['add a login form'])
  expect(h.dagCount()).toBe(0)

  // An edited draft is re-validated without the planner; a broken edit is a 400, still no dag.
  const preview = await h.call(h.human(), '/api/dag/plan/preview', { title: 'Add login', tasks: (job.draft as typeof draft).tasks.slice(0, 1) })
  expect(preview).toMatchObject({ status: 200, body: { waves: [['api']] } })
  expect((await h.call(h.human(), '/api/dag/plan/preview', { title: 'x', tasks: [{ key: 'a', brief: {} }] }))?.status).toBe(400)
  expect(h.intents.length).toBe(1)
  expect(h.dagCount()).toBe(0)

  // Approval = POST /api/dag with the draft; workers dispatch and the view lists them for the canvas.
  const created = await h.call(h.human(), '/api/dag', { projectId: job.projectId, title: 'Add login', repo: job.repo, tasks: (job.draft as typeof draft).tasks })
  expect(created?.status).toBe(201)
  const dagId = (created!.body as { dag: { id: string } }).dag.id
  await h.s.tick()
  const view = (await h.call(h.human('GET'), `/api/dag/${dagId}`))!.body as { dispatches: { taskId: string; nodeId: string; worktree: string }[]; tasks: { id: string; key: string }[] }
  expect(view.dispatches).toHaveLength(1)
  expect(view.tasks.find((t) => t.id === view.dispatches[0].taskId)?.key).toBe('api')
  expect(view.dispatches[0].nodeId.startsWith('dag-')).toBe(true)
  expect(view.dispatches[0].worktree.startsWith('/tmp/st/wt-api-')).toBe(true)
})

test('agents cannot draft or approve a plan (403), and nothing runs', async () => {
  const h = setup(async () => draft)
  expect((await h.call(h.agent, '/api/dag/plan', { intent: 'x y', workspaceId: 'w9' }))?.status).toBe(403)
  expect((await h.call(h.agent, '/api/dag', { projectId: 'w9', title: 'x', repo: '/tmp/st/repo9', tasks: draft.tasks }))?.status).toBe(403)
  expect(h.intents).toEqual([])
  expect(h.dagCount()).toBe(0)
})

test('a planner failure or an invalid draft ends as failed with the reason; bad input is a 4xx', async () => {
  const h = setup(async () => ({ title: 'x', tasks: [{ key: 'a', kind: 'work', deps: ['zz'], brief: draft.tasks[0].brief }] }))
  const job = await h.poll(((await h.call(h.human(), '/api/dag/plan', { intent: 'do it', workspaceId: 'w9' }))!.body as { planId: string }).planId)
  expect(job.status).toBe('failed')
  expect(String(job.error)).toContain('unknown zz')
  expect((await h.call(h.human(), '/api/dag/plan', { intent: '', workspaceId: 'w9' }))?.status).toBe(400)
  expect((await h.call(h.human(), '/api/dag/plan', { intent: 'x', workspaceId: 'nope' }))?.status).toBe(404)
  expect((await h.call(h.human('GET'), '/api/dag/plan/unknown'))?.status).toBe(404)
  expect(h.dagCount()).toBe(0)
})

test('the planner is read-only Claude Code with a strict JSON schema; its answer is structured_output', () => {
  const argv = plannerArgv('add login')
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  const at = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(at('--output-format')).toBe('json')
  expect(at('--tools')).toBe('Read,Grep,Glob')
  expect(at('--permission-mode')).toBe('dontAsk')
  expect(JSON.parse(at('--json-schema'))).toMatchObject({ type: 'object', required: ['title', 'tasks'] })
  const done = (lastEvent: Record<string, unknown> | null): ExecOutcome => ({ exitCode: 0, timedOut: false, killed: false, lastEvent, tail: '' })
  expect(plannerOutput(done({ type: 'result', structured_output: draft }))).toBe(draft)
  const thrown = (f: () => unknown): string => { try { f(); return '' } catch (e) { return (e as Error).message } }
  expect(thrown(() => plannerOutput(done({ type: 'result', result: 'I refuse' })))).toContain('I refuse')
  expect(thrown(() => plannerOutput({ ...done(null), timedOut: true }))).toContain('timed out')
})
