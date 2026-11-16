// Bun-only: Central answers a worker's held permission prompt first (docs/decisions/central-approver.md).
// Locks the routing (central vs human), every hard limit (a-d), the anti-hang fallbacks and the bounded record.
import { expect, test } from 'bun:test'
import type { AppendEventInput } from '../events/eventModel'
import { freshDb, rows, T0 } from '../central/guard/controlGuard.testutil'
import { toolCapability } from '../central/tools/toolCapability'
import { createRegistry } from '../central/tools/toolRegistry'
import { registerCa2Tools } from '../central/tools/registerAll'
import { ALLOW_ALL_GUARD, execTool } from '../central/tools/toolExec'
import { PERMISSION_DEFS } from '../central/tools/defs/permission.defs'
import { listInboxItems } from '../inbox/inboxItemStore'
import { approvalDigest, getApproval, requestApproval } from '../ledger/ledgerApproval'
import { createPolicy } from '../policy/policy.decide'
import { CENTRAL_ACTOR, NOTICE_PER_HOUR, centralHoldReason, decideByCentral } from './permission.central'
import { decidePermission, listPendingPermissions } from './permission.human'
import { PERMISSION_KIND, VIA_CENTRAL } from './permission.model'
import { centralRoute } from './permission.runtime'
import { getOrCreateConversation } from '../central/conversationStore'
import { createWorkStore } from '../central/work/workStore'
import { setCheckinKick } from '../central/work/workCheckin.kick'
import { answerPermission, type CentralRoute, type PermissionWaitDeps } from './permission.wait'

const ask = (command: string, nodeId = 'a1') => ({ nodeId, nodeTitle: 'brisk-otter', workspaceId: 'w1', body: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } } })
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

function setup(central: Partial<CentralRoute> | null = {}) {
  const db = freshDb()
  let t = T0
  const now = () => t
  const policy = createPolicy({ db, now })
  const events: AppendEventInput[] = []
  const woken: string[] = []
  let onWait: ((id: string) => void) | null = null
  const route: CentralRoute | undefined = central === null ? undefined : { unavailable: () => null, wake: (r) => { woken.push(r.approvalId) }, decideMs: 5_000, ...central }
  const deps: PermissionWaitDeps = {
    db, policy, projectId: 'p1', waitMs: 20_000, now, pollMs: 500, record: (e) => { events.push(e) }, ...(route ? { central: route } : {}),
    sleep: async (ms) => {
      const open = rows(db, "SELECT id FROM approval WHERE kind = ? AND status = 'pending'", PERMISSION_KIND)[0]
      if (onWait && open) { const fn = onWait; onWait = null; fn(String(open.id)) }
      t += ms
    },
  }
  const centralDecide = (id: string, decision: 'allow' | 'deny' | 'escalate', reason?: string) =>
    decideByCentral({ db, now, record: (e) => { events.push(e) } }, { approvalId: id, decision, conversationId: 'central:global', ...(reason ? { reason } : {}) })
  return { db, policy, deps, events, woken, now, centralDecide, onWait: (fn: (id: string) => void) => { onWait = fn } }
}
const humanVisible = (s: ReturnType<typeof setup>) => listInboxItems({ db: s.db, now: s.now }).length + listPendingPermissions(s.db, s.now()).length

test('routing central: the card stays off every human surface, Central allows once, the reply allows and the record names Central', async () => {
  const s = setup()
  const grantsBefore = rows(s.db, 'SELECT count(*) AS c FROM policy_grant')[0].c
  s.onWait((id) => {
    expect(humanVisible(s)).toBe(0)
    expect(s.woken).toEqual([id])
    expect(s.centralDecide(id, 'allow', 'plain test run')).toEqual({ ok: true, status: 'approved' })
  })
  expect(await answerPermission(s.deps, ask('npm test'))).toEqual(ALLOW)
  expect(rows(s.db, 'SELECT approved_by FROM approval')[0].approved_by).toBe(CENTRAL_ACTOR)
  expect(s.events.find((e) => e.kind === 'permission.decision')).toMatchObject({ actor: CENTRAL_ACTOR, payload: { behavior: 'allow', by: CENTRAL_ACTOR, reason: 'plain test run' } })
  const auto = s.events.find((e) => e.kind === 'auto.central_permission')
  expect(auto).toMatchObject({ actor: CENTRAL_ACTOR, nodeId: 'a1' })
  expect(String((auto?.payload as { text: string }).text)).toContain('Central allowed brisk-otter running Bash(npm test): plain test run')
  expect(rows(s.db, 'SELECT count(*) AS c FROM policy_grant')[0].c).toBe(grantsBefore) // allow-once leaves no permanent rule (limit c)
})

test('routing central: a Central deny reaches Claude with Central and its reason', async () => {
  const s = setup()
  s.onWait((id) => { s.centralDecide(id, 'deny', 'not part of the task') })
  const out = await answerPermission(s.deps, ask('npm test'))
  expect(out?.hookSpecificOutput.decision).toMatchObject({ behavior: 'deny' })
  expect(out?.hookSpecificOutput.decision.message).toContain('Central')
  expect(out?.hookSpecificOutput.decision.message).toContain('not part of the task')
})

test('routing human (no central route) keeps the old behavior: the card is on the human surfaces at once', async () => {
  const s = setup(null)
  s.onWait((id) => {
    expect(humanVisible(s)).toBeGreaterThan(0)
    expect(decidePermission(s.db, s.policy, { id, choice: 'allow' }, 'human:loopback', s.now()).status).toBe(200)
  })
  expect(await answerPermission(s.deps, ask('npm test'))).toEqual(ALLOW)
  expect(rows(s.db, "SELECT request_json FROM approval")[0].request_json).not.toContain(VIA_CENTRAL)
})

test('limit a: a request from Central itself is never Central to decide; it goes to the human with the reason', async () => {
  const s = setup()
  s.onWait((id) => {
    expect(s.woken).toEqual([])
    const item = listInboxItems({ db: s.db, now: s.now }).find((i) => i.approvalId === id)
    expect(item?.body).toContain('Central itself')
    expect(decidePermission(s.db, s.policy, { id, choice: 'allow' }, 'human:loopback', s.now()).status).toBe(200)
  })
  expect(await answerPermission(s.deps, ask('npm test', 'central-mcp-identity'))).toEqual(ALLOW)
  expect(centralHoldReason({ nodeId: 'central', tool: 'Bash', label: 'Bash(ls)' })).toContain('Central itself')
})

test('limit b: push/destructive/secret requests go to the human at request time, never to Central', async () => {
  for (const command of ['git push origin main', 'rm -rf build', 'cat .env']) {
    const s = setup()
    s.onWait(() => { expect(s.woken).toEqual([]); expect(humanVisible(s)).toBeGreaterThan(0) })
    await answerPermission(s.deps, ask(command))
  }
})

test('limit b at decision time: a held card that is dangerous, or not a permission prompt at all, cannot be decided by Central', () => {
  const s = setup()
  const held = (id: string, label: string, tool = 'Bash') => requestApproval({ db: s.db, now: s.now }, { id, projectId: 'p1', kind: PERMISSION_KIND, request: { nodeId: 'a1', node: 'n', tool, label, pattern: null, via: VIA_CENTRAL } })
  held('perm_danger', 'Bash(git push --force origin main)')
  expect(s.centralDecide('perm_danger', 'allow')).toMatchObject({ ok: false, code: 'needs_human' })
  expect(getApproval({ db: s.db, now: s.now }, 'perm_danger')?.status).toBe('pending')
  expect(listInboxItems({ db: s.db, now: s.now }).find((i) => i.approvalId === 'perm_danger')?.body).toContain('Central passed this to you')
  // other kinds: model.fable, level/control, secret, spawn...
  for (const kind of ['model.fable', 'control.level', 'secret.access', 'agent.spawn', 'inbox.gate']) {
    requestApproval({ db: s.db, now: s.now }, { id: `x_${kind}`, projectId: 'p1', kind, request: { via: VIA_CENTRAL, label: 'x' } })
    expect(s.centralDecide(`x_${kind}`, 'allow')).toEqual({ ok: false, code: 'not_permission' })
    expect(getApproval({ db: s.db, now: s.now }, `x_${kind}`)?.status).toBe('pending')
  }
})

test('limit c: Central only has allow-once/deny/escalate, the human route refuses its actor, and no rule is ever written', async () => {
  const input = PERMISSION_DEFS[0].input as { properties: { verdict: { enum: string[] } } }
  expect(input.properties.verdict.enum).toEqual(['allow', 'deny', 'escalate'])
  const s = setup()
  const before = s.policy.store.grants().length
  s.onWait((id) => {
    expect(decidePermission(s.db, s.policy, { id, choice: 'always' }, CENTRAL_ACTOR, s.now()).status).toBe(403)
    expect(decidePermission(s.db, s.policy, { id, choice: 'allow' }, 'classifier', s.now()).status).toBe(403)
    s.centralDecide(id, 'allow')
  })
  await answerPermission(s.deps, ask('npm test'))
  expect(s.policy.store.grants().length).toBe(before)
})

test('limit d: the tool is Central-projection only, runs only from a Central conversation, and a project chat stays in its project', async () => {
  expect(toolCapability(PERMISSION_DEFS[0]).projections).toEqual(['central'])
  const registry = createRegistry()
  expect(registerCa2Tools(registry, {}, { WEBTERM_CENTRAL: 'on' })).toContain('permission.decide')
  const s = setup()
  requestApproval({ db: s.db, now: s.now }, { id: 'perm_1', projectId: 'p1', kind: PERMISSION_KIND, request: { nodeId: 'a1', node: 'n', tool: 'Bash', label: 'Bash(npm test)', pattern: null, via: VIA_CENTRAL } })
  const run = (conversationId: string, verdict = 'allow') => execTool({ db: s.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R3', conversationId, now: s.now, env: { WEBTERM_CENTRAL: 'on' } }, 'permission.decide', { approvalId: 'perm_1', verdict })
  expect(await run('node:a1')).toMatchObject({ ok: false, code: 'not_central' })
  expect(await run('central:project:p2')).toMatchObject({ ok: false, code: 'conversation_project_mismatch' })
  expect(await run('central:global', 'always')).toMatchObject({ ok: false })
  expect(getApproval({ db: s.db, now: s.now }, 'perm_1')?.status).toBe('pending')
  expect(await run('central:project:p1')).toMatchObject({ ok: true, data: { status: 'approved' } })
  expect(getApproval({ db: s.db, now: s.now }, 'perm_1')).toMatchObject({ status: 'approved', approvedBy: CENTRAL_ACTOR })
})

test('Central escalates: the same card reaches the human with the reason, and Central can no longer decide it', async () => {
  const s = setup()
  s.onWait((id) => {
    expect(s.centralDecide(id, 'escalate', 'unsure what this touches')).toEqual({ ok: true, status: 'escalated' })
    expect(listInboxItems({ db: s.db, now: s.now }).find((i) => i.approvalId === id)?.body).toContain('unsure what this touches')
    expect(s.centralDecide(id, 'allow')).toMatchObject({ ok: false, code: 'escalated' })
    expect(decidePermission(s.db, s.policy, { id, choice: 'deny' }, 'human:loopback', s.now()).status).toBe(200)
  })
  expect((await answerPermission(s.deps, ask('npm test')))?.hookSpecificOutput.decision.behavior).toBe('deny')
})

test('fallback: Central silent past its window = the same card goes to the human; nobody answers = no decision, never auto-allow', async () => {
  const s = setup()
  let seenAt = -1
  const sleep = s.deps.sleep!
  s.deps.sleep = async (ms) => {
    if (seenAt < 0 && humanVisible(s) > 0) { seenAt = s.now() - T0; s.onWait((id) => { decidePermission(s.db, s.policy, { id, choice: 'allow' }, 'human:loopback', s.now()) }) }
    await sleep(ms)
  }
  expect(await answerPermission(s.deps, ask('npm test'))).toEqual(ALLOW)
  expect(seenAt >= 5_000).toBe(true)
  const idle = setup()
  expect(await answerPermission(idle.deps, ask('npm test'))).toBeNull()
  expect(rows(idle.db, 'SELECT status FROM approval')[0].status).toBe('expired')
})

test('fallback: Central unavailable, or failing to wake, shows the card to the human immediately', async () => {
  const off = setup({ unavailable: () => 'Central is off' })
  off.onWait(() => { expect(off.woken).toEqual([]); expect(listInboxItems({ db: off.db, now: off.now })[0]?.body).toContain('Central is off') })
  await answerPermission(off.deps, ask('npm test'))
  const broken = setup({ wake: () => { throw new Error('engine down') } })
  broken.onWait(() => { expect(listInboxItems({ db: broken.db, now: broken.now })[0]?.body).toContain('could not be reached') })
  await answerPermission(broken.deps, ask('npm test'))
})

test('transparency is bounded: every decision is a record, only NOTICE_PER_HOUR reach the chat', () => {
  const s = setup()
  const total = NOTICE_PER_HOUR + 5
  for (let i = 0; i < total; i++) {
    requestApproval({ db: s.db, now: s.now }, { id: `perm_${i}`, projectId: 'p1', kind: PERMISSION_KIND, request: { nodeId: 'a1', node: 'brisk-otter', tool: 'Bash', label: 'Bash(npm test)', pattern: null, via: VIA_CENTRAL } })
    expect(s.centralDecide(`perm_${i}`, 'allow', 'x'.repeat(500))).toMatchObject({ ok: true })
  }
  const autos = s.events.filter((e) => e.kind === 'auto.central_permission')
  expect(autos).toHaveLength(total)
  expect(Math.max(...autos.map((e) => String((e.payload as { text: string }).text).length)) <= 300).toBe(true)
  const notices = rows(s.db, "SELECT 1 FROM central_message WHERE role = 'system'").length
  expect(notices <= NOTICE_PER_HOUR).toBe(true)
  expect(notices).toBeGreaterThan(0)
  expect(approvalDigest({})).toBeTruthy()
})

test('wiring: a worker with an open assignment wakes Central in the chat that asked for its work; an unassigned one routes by project', () => {
  const s = setup()
  const origin = getOrCreateConversation(s.db, `chat:${crypto.randomUUID()}`).id
  const work = createWorkStore(s.db, s.now)
  work.createTask({ id: 'tk1', projectId: 'p1', title: 't', objective: 'o', actor: { kind: 'central' } })
  work.openAssignment({ taskId: 'tk1', nodeId: 'n-assigned', channel: 'terminal', instruction: 'go', actor: { kind: 'central' }, conversationId: origin })
  const route = centralRoute(s.db, s.policy, true)
  setCheckinKick(() => {})
  try {
    for (const [id, nodeId] of [['perm_a', 'n-assigned'], ['perm_b', 'n-free']] as const) {
      requestApproval({ db: s.db, now: s.now }, { id, projectId: 'p1', kind: PERMISSION_KIND, request: { nodeId } })
      route.wake({ approvalId: id, projectId: 'p1', node: 'brisk-otter', label: 'Bash(ls)' })
    }
  } finally { setCheckinKick(null) }
  expect(rows(s.db, "SELECT dedupe_key, conversation_id FROM central_checkin_reason ORDER BY dedupe_key")).toEqual([{ dedupe_key: 'perm:perm_a', conversation_id: origin }, { dedupe_key: 'perm:perm_b', conversation_id: null }])
})

test('wiring: waking Central queues one durable check-in reason and kicks the pass; no engine = an error (so the card goes to the human)', () => {
  const s = setup()
  const route = centralRoute(s.db, s.policy, true)
  const wake = { approvalId: 'perm_w', projectId: 'p1', node: 'brisk-otter', label: 'Bash(npm test)' }
  setCheckinKick(null)
  let err = ''
  try { route.wake(wake) } catch (e) { err = String(e) }
  expect(err).toContain('not running')
  let kicks = 0
  setCheckinKick(() => { kicks++ })
  route.wake(wake)
  route.wake(wake) // same approval: deduped, never a second turn
  setCheckinKick(null)
  const queued = rows(s.db, "SELECT kind, text, not_before FROM central_checkin_reason WHERE dedupe_key = 'perm:perm_w'")
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({ kind: 'permission_request' })
  expect(String(queued[0].text)).toContain('permission.decide')
  expect(kicks).toBe(2)
  expect(centralRoute(s.db, s.policy, false).unavailable('p1')).toBeTruthy() // check-ins off (or Central off): never held for Central
})
