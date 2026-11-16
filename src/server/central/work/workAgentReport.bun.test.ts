// Bun-only: `webterm report` end to end over `/api/tools/agent.report` with real node tokens, the real ledger policy,
// the real work store and the real check-in engine (its onMove), so each assertion is the move and the wake Central gets.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { toolsRoute, type ToolsDeps } from '../../capability/capability.http'
import { createMemoryReceiptLog } from '../../capability/capability.receipt'
import { REPORT_RATE_MAX, REPORT_TEXT_MAX } from '../../capability/report.capabilities'
import { createSeenStore } from '../../cli/cli.seen'
import { resetEventsRuntimeForTest } from '../../events/eventsRuntime'
import { NODE_TOKEN_HEADER, nodeToken, resetNodeTokenMemoryForTest } from '../../hooksTokens'
import { allRows } from '../../ledger/ledgerCore'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import { resetActiveLedgerRuntimeForTest, setActiveLedgerRuntime } from '../../ledger/ledgerRuntimeState'
import { resetActivePolicyForTest } from '../../policy/policy.runtime'
import { getOrCreateConversation } from '../conversationStore'
import { createAgentStore } from '../agents/agentStore'
import { createMailStore, MAIL_TTL_MS } from '../agents/mailStore'
import { openWork } from '../context/contextHeaderWork'
import { recordAgentReport, resetReportRateForTest } from './workAgentReport'
import { createWorkCheckin } from './workCheckin'
import { event, rig } from './workRig.testutil'
import { buildResult, stashStopResult, type WorkResult } from './workResult'
import { startWorkWatcher } from './workWatcher'
import { onWorkMove } from './workStore'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'agent-report-'))
const saved = { data: process.env.WEBTERM_DATA_DIR, home: process.env.HOME, claude: process.env.CLAUDE_CONFIG_DIR }
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.HOME = join(root, 'home')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
afterAll(() => {
  for (const [k, v] of [['WEBTERM_DATA_DIR', saved.data], ['HOME', saved.home], ['CLAUDE_CONFIG_DIR', saved.claude]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

const AGENT = 'ag1'
const NODE = `c-${AGENT}`
let n = 0

function setup() {
  const r = rig()
  r.clock.t = Date.now() // the HTTP path reports on the wall clock (cli.exec); keep mail TTLs on the same one
  setActiveLedgerRuntime({ mode: 'on', path: ':memory:', db: r.db, ledger: {} } as unknown as LedgerRuntime)
  createAgentStore(r.db, r.now).create({ id: AGENT, projectId: 'p1', kind: 'claude', role: 'worker', runner: 'pty', owner: 'central:central:global', reqId: 'rq1' })
  const checkin = createWorkCheckin({ db: r.db, store: r.store, now: r.now, settings: { read: async () => ({ enabled: true, dailyLimit: 20 }), write: async () => {} }, submit: () => 'turn', notice: () => true })
  onWorkMove(r.db, (m) => { checkin.onMove(m) })
  const wakes = () => allRows(r.db, 'SELECT kind FROM central_checkin_reason ORDER BY created_at, id').map((w) => String(w.kind))
  const deps: ToolsDeps = { dispatch: async () => {}, workspaces: () => [], receipts: createMemoryReceiptLog(), seen: createSeenStore(join(root, `seen-${n++}`)) }
  return { ...r, wakes, deps }
}

async function report(deps: ToolsDeps, body: unknown, token: string | null = nodeToken(NODE)) {
  const server = createServer((req, res) => { void toolsRoute(req, res, new URL(req.url ?? '/', 'http://x'), deps) })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tools/agent.report`, { method: 'POST', headers: token ? { [NODE_TOKEN_HEADER]: token } : {}, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as { receipt: { outcome: string; detail: string }; data?: { moved: string | null; answeredAsk: boolean; mailId: string | null } } }
  } finally {
    server.close()
  }
}

beforeEach(() => { resetNodeTokenMemoryForTest(); resetEventsRuntimeForTest(); resetActivePolicyForTest(); resetReportRateForTest() })
afterEach(() => { resetActivePolicyForTest(); resetActiveLedgerRuntimeForTest(); resetNodeTokenMemoryForTest() })

test('done, blocked and question each move the task and wake Central with their own reason; progress does neither', async () => {
  for (const [kind, status, wake] of [['done', 'reported', 'task_report'], ['blocked', 'waiting_input', 'task_blocked'], ['question', 'waiting_input', 'task_input']] as const) {
    resetReportRateForTest()
    const s = setup()
    const { taskId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
    const r = await report(s.deps, { kind, text: `the ${kind} text` })
    expect(r).toMatchObject({ status: 200, body: { receipt: { outcome: 'ok' }, data: { moved: status } } })
    expect(s.statusOf(taskId)).toBe(status)
    expect(s.wakes()).toEqual([wake])
    expect(s.store.timeline(taskId).some((e) => e.kind === 'work.agent_report' && e.reason === `${kind}: the ${kind} text`)).toBe(true)
    const line = allRows(s.db, "SELECT parts_json FROM central_message WHERE conversation_id = 'central:global' AND role = 'system'").map((m) => String(m.parts_json))
    expect(line.some((p) => p.includes(`Agent ${AGENT} reported ${kind}: the ${kind} text`))).toBe(true)
  }
  const s = setup()
  const { taskId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  const r = await report(s.deps, { kind: 'progress', text: 'half way' })
  expect(r.body.data).toMatchObject({ moved: null, answeredAsk: false })
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.wakes()).toEqual([])
  // Recorded and shown in the State header's open work instead.
  expect(openWork(s.db, s.now()).projects[0]?.open[0]?.report).toBe('progress: half way')
})

test('the progress wake carries the conversation the agent was started from, not the project chat', async () => {
  const s = setup()
  const origin = getOrCreateConversation(s.db, `chat:${crypto.randomUUID()}`).id // a chat that is neither global nor the project chat
  s.db.query('UPDATE central_agents SET owner = ? WHERE id = ?').run(`central:${origin}`, AGENT)
  s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  createMailStore(s.db, s.now).send(`central:${origin}`, { projectId: 'p1', threadId: '', toRef: `agent:${AGENT}`, kind: 'ask', body: 'how far?', reqId: 'ask2' })
  await report(s.deps, { kind: 'progress', text: 'tests left' })
  expect(allRows(s.db, "SELECT conversation_id FROM central_checkin_reason WHERE kind = 'task_report'")).toEqual([{ conversation_id: origin }])
})

test('progress wakes Central once when it asked (an open ask from Central), and answers that ask', async () => {
  const s = setup()
  s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  const ask = createMailStore(s.db, s.now).send('central:central:global', { projectId: 'p1', threadId: '', toRef: `agent:${AGENT}`, kind: 'ask', body: 'how far?', reqId: 'ask1' })
  expect((await report(s.deps, { kind: 'progress', text: 'tests left' })).body.data).toMatchObject({ moved: null, answeredAsk: true })
  expect(s.wakes()).toEqual(['task_report'])
  expect(ask.ok && createMailStore(s.db, s.now).get(ask.mail.id)?.ackedAt).toEqual(expect.any(Number))
  await report(s.deps, { kind: 'progress', text: 'more' })
  expect(s.wakes()).toEqual(['task_report'])
})

test('oversize, empty and over-rate reports are refused with a receipt and change nothing', async () => {
  const s = setup()
  const { taskId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  expect(await report(s.deps, { kind: 'done', text: 'x'.repeat(REPORT_TEXT_MAX + 1) })).toMatchObject({ status: 400, body: { receipt: { outcome: 'error', detail: 'text_too_long' } } })
  expect(await report(s.deps, { kind: 'done', text: '  ' })).toMatchObject({ body: { receipt: { detail: 'empty_text' } } })
  expect(await report(s.deps, { kind: 'nope', text: 'x' })).toMatchObject({ body: { receipt: { detail: 'invalid_shape' } } })
  for (let i = 0; i < REPORT_RATE_MAX; i++) expect((await report(s.deps, { kind: 'progress', text: `p${i}` })).status).toBe(200)
  expect(await report(s.deps, { kind: 'done', text: 'finally' })).toMatchObject({ status: 400, body: { receipt: { outcome: 'error', detail: 'rate_limited' } } })
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.wakes()).toEqual([])
})

test('a missing or wrong node token is refused; a node with no Central work is refused', async () => {
  const s = setup()
  const { taskId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  expect(await report(s.deps, { kind: 'done', text: 'x' }, null)).toMatchObject({ status: 403, body: { receipt: { outcome: 'denied', detail: 'not_an_agent' } } })
  expect(await report(s.deps, { kind: 'done', text: 'x' }, 'not-a-token')).toMatchObject({ status: 403, body: { receipt: { outcome: 'denied', detail: 'not_an_agent' } } })
  expect(await report(s.deps, { kind: 'done', text: 'x' }, nodeToken('stranger'))).toMatchObject({ status: 400, body: { receipt: { detail: 'not_central_work' } } })
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.wakes()).toEqual([])
})

test('retention: a report is mail with the 24 h TTL, acked so it never fills the mailbox, and purged when expired', () => {
  const s = setup()
  s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  const mail = createMailStore(s.db, s.now)
  for (let i = 0; i < 30; i++) {
    resetReportRateForTest()
    const r = recordAgentReport(s.db, s.now, NODE, 'progress', `p${i}`)
    expect(r.ok && r.data.mailId).toEqual(expect.any(String))
  }
  const rows = allRows(s.db, 'SELECT created_at, expires_at FROM agent_mail')
  expect(rows).toHaveLength(30)
  expect(rows.every((m) => Number(m.expires_at) - Number(m.created_at) === MAIL_TTL_MS)).toBe(true)
  expect(mail.unackedCount('central:central:global')).toBe(0)
  s.clock.t += MAIL_TTL_MS
  expect(mail.purgeExpired()).toBe(30)
})

test('an agent spawned with no task has no card (agent.defs), so its boot turn (prompt, Stop) moves nothing and wakes nothing', () => {
  const s = setup()
  const stop = startWorkWatcher({ store: s.store, now: s.now, bus: s.bus, onReported: () => {}, onSessionEnded: () => {} })
  s.bus.publish(event('hook.UserPromptSubmit', {}, NODE))
  s.bus.publish(event('hook.Stop', {}, NODE))
  stop()
  expect(s.store.listTasks({ projectId: 'p1' })).toEqual([])
  expect(s.wakes()).toEqual([])
})

const resultOf = (s: ReturnType<typeof setup>, id: string) => s.store.getAssignment(id)?.result as WorkResult | null

test('report --done stores its text as the attempt result (source agent_report) before the task is reported', async () => {
  const s = setup()
  const { taskId, assignmentId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  const seen: unknown[] = []
  onWorkMove(s.db, (m) => { if (m.to === 'reported') seen.push(resultOf(s, assignmentId)?.source) })
  await report(s.deps, { kind: 'done', text: 'RESULT: shipped the fix' })
  expect(s.statusOf(taskId)).toBe('reported')
  expect(resultOf(s, assignmentId)).toMatchObject({ source: 'agent_report', text: 'RESULT: shipped the fix', resultLine: 'shipped the fix' })
  expect(seen).toEqual(['agent_report'])
  // blocked / question / progress are not results.
  const t = setup()
  const b = t.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  await report(t.deps, { kind: 'question', text: 'which db?' })
  expect(resultOf(t, b.assignmentId)).toBeNull()
})

test('report --done does not overwrite the richer result a Stop already captured', async () => {
  const s = setup()
  const { assignmentId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  s.store.recordResult(assignmentId, buildResult('stop_hook', 'long final message from the Stop hook', s.now()))
  await report(s.deps, { kind: 'done', text: 'short done' })
  expect(resultOf(s, assignmentId)).toMatchObject({ source: 'stop_hook', text: 'long final message from the Stop hook' })
})

test('a Stop that arrives after report --done replaces the report text with its richer capture', async () => {
  const s = setup()
  const { taskId, assignmentId } = s.assigned('running', { channel: 'spawn', agentId: AGENT, nodeId: NODE })
  const off = startWorkWatcher({ store: s.store, now: s.now, bus: s.bus, onReported: () => {}, onSessionEnded: () => {} })
  await report(s.deps, { kind: 'done', text: 'short done' })
  stashStopResult(NODE, buildResult('stop_hook', 'the full last message', s.now()))
  s.bus.publish(event('hook.Stop', {}, NODE))
  off()
  expect(s.statusOf(taskId)).toBe('reported')
  expect(resultOf(s, assignmentId)).toMatchObject({ source: 'stop_hook', text: 'the full last message' })
})
