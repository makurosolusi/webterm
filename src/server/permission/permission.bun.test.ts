// Bun-only: the held PermissionRequest over the real ledger schema + policy engine: allow once, deny,
// timeout (no decision), always-allow writes a human-ui grant that answers later requests, events.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { approvalHumanRoute } from '../approvalHumanApi'
import { createLedger } from '../ledger/ledger'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { AppendEventInput } from '../events/eventModel'
import { freshDb, rows, T0 } from '../central/guard/controlGuard.testutil'
import { createPolicy } from '../policy/policy.decide'
import { actOnItem } from '../inbox/inboxActions'
import { listInboxItems } from '../inbox/inboxItemStore'
import { decidePermission, listPendingPermissions } from './permission.human'
import { answerPermission, PERMISSION_DECISION_EVENT, PERMISSION_REQUEST_EVENT, type PermissionWaitDeps } from './permission.wait'

const body = (command: string) => ({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } })

function setup() {
  const db = freshDb()
  let t = T0
  const now = () => t
  const policy = createPolicy({ db, now })
  const events: AppendEventInput[] = []
  let human: ((id: string) => void) | null = null
  const deps: PermissionWaitDeps = {
    db, policy, projectId: 'p1', waitMs: 10_000, now, pollMs: 500, record: (e) => { events.push(e) },
    // The "human" acts during the first wait tick; time advances like a real clock would.
    sleep: async (ms) => {
      const open = listPendingPermissions(db, t)[0]
      if (human && open) { human(open.id); human = null }
      t += ms
    },
  }
  return { db, policy, deps, events, now, onFirstWait: (fn: (id: string) => void) => { human = fn } }
}

const ask = (command: string) => ({ nodeId: 'a1', nodeTitle: 'brisk-otter', workspaceId: 'w1', body: body(command) })

test('allow once: inbox item appears, the human allows, the reply is the documented allow shape', async () => {
  const s = setup()
  let seen: unknown
  s.onFirstWait((id) => {
    seen = listPendingPermissions(s.db, s.now())[0]
    expect(decidePermission(s.db, s.policy, { id, choice: 'allow' }, 'human:loopback', s.now()).status).toBe(200)
  })
  const out = await answerPermission(s.deps, ask('npm publish'))
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  expect(seen).toMatchObject({ node: 'brisk-otter', label: 'Bash(npm publish)', pattern: 'npm publish', tool: 'Bash' })
  expect(listPendingPermissions(s.db, s.now())).toHaveLength(0)
  expect(s.events.map((e) => e.kind)).toEqual([PERMISSION_REQUEST_EVENT, PERMISSION_DECISION_EVENT])
  expect(s.events[1]).toMatchObject({ actor: 'human:loopback', payload: { behavior: 'allow', by: 'human:loopback' } })
  // Single use: the consent was consumed by the hook.
  expect(rows(s.db, "SELECT d.single_use AS u FROM approval a JOIN decision d ON d.id = a.decision_id")[0].u).toBe(0)
})

test('edit in the Inbox: Claude gets the edited tool input as updatedInput; unchanged approve sends none', async () => {
  const s = setup()
  const deps = { ctx: { db: s.db, now: s.now }, actor: 'human:loopback', record: () => {}, outbox: async () => { throw new Error('no outbox in this test') } }
  s.onFirstWait((id) => {
    const item = listInboxItems(deps.ctx).find((i) => i.approvalId === id)
    expect(item?.actions).toContain('edit')
    expect(item?.args).toEqual({ command: 'npm publish' })
    void actOnItem(deps, id, { type: 'edit', args: { command: 'npm publish --dry-run' } })
  })
  const out = await answerPermission(s.deps, ask('npm publish'))
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'npm publish --dry-run' } } } })
  expect(s.events.at(-1)).toMatchObject({ payload: { behavior: 'allow', edited: true } })

  s.onFirstWait((id) => { void actOnItem(deps, listInboxItems(deps.ctx).find((i) => i.approvalId === id)!.id, { type: 'approve' }) })
  expect(await answerPermission(s.deps, ask('ls'))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
})

test('deny: the reply blocks with a message for Claude', async () => {
  const s = setup()
  s.onFirstWait((id) => { decidePermission(s.db, s.policy, { id, choice: 'deny' }, 'human:loopback', s.now()) })
  const out = await answerPermission(s.deps, ask('npm publish'))
  expect(out?.hookSpecificOutput.decision.behavior).toBe('deny')
  expect(out?.hookSpecificOutput.decision.message).toContain('denied')
  expect(s.events.at(-1)).toMatchObject({ kind: PERMISSION_DECISION_EVENT, payload: { behavior: 'deny' } })
})

test('timeout: no decision (Claude falls back to its own prompt) and the card leaves the inbox', async () => {
  const s = setup()
  expect(await answerPermission(s.deps, ask('npm publish'))).toBeNull()
  expect(listPendingPermissions(s.db, s.now())).toHaveLength(0)
  expect(rows(s.db, 'SELECT status FROM approval')[0].status).toBe('expired')
  expect(s.events.at(-1)).toMatchObject({ payload: { behavior: 'none', by: 'timeout' } })
})

test('a closed hook stops the wait without a decision', async () => {
  const s = setup()
  const gone = new AbortController()
  s.onFirstWait(() => gone.abort())
  expect(await answerPermission(s.deps, { ...ask('ls'), signal: gone.signal })).toBeNull()
  expect(s.events.at(-1)).toMatchObject({ payload: { by: 'hook_closed' } })
})

test('always allow: writes a permanent human-ui grant, allows now, and auto-allows the next call', async () => {
  const s = setup()
  let grantId = ''
  s.onFirstWait((id) => {
    const r = decidePermission(s.db, s.policy, { id, choice: 'always' }, 'human:loopback', s.now())
    grantId = (r.body as { grantId: string }).grantId
  })
  expect((await answerPermission(s.deps, ask('npm publish')))?.hookSpecificOutput.decision.behavior).toBe('allow')
  const grant = s.policy.store.grants().find((g) => g.id === grantId)
  expect(grant).toMatchObject({ subject: 'node:*', capability: 'claude.tool:Bash', scope: 'npm publish', effect: 'allow', origin: 'human-ui', expiresAt: null })

  const before = rows(s.db, 'SELECT COUNT(*) AS n FROM approval')[0].n
  const again = await answerPermission({ ...s.deps, waitMs: 0 }, ask('npm publish'))
  expect(again?.hookSpecificOutput.decision.behavior).toBe('allow')
  expect(rows(s.db, 'SELECT COUNT(*) AS n FROM approval')[0].n).toBe(before) // no new inbox item
  expect(s.events.at(-1)).toMatchObject({ payload: { behavior: 'allow', by: 'rule', ruleId: grantId } })
  // A different command is not covered by the rule.
  expect(await answerPermission({ ...s.deps, waitMs: 0 }, ask('npm publish --force'))).toBeNull()
})

test('a non-tool grant (node:* allow *) never auto-answers a tool prompt', async () => {
  const s = setup()
  expect(s.policy.createGrant('human-ui', { subject: 'node:*', capability: '*', effect: 'allow' }).ok).toBe(true)
  expect(await answerPermission({ ...s.deps, waitMs: 0 }, ask('rm -rf /'))).toBeNull()
})

test('decide refuses unknown, already-decided and unsafe-pattern requests', async () => {
  const s = setup()
  expect(decidePermission(s.db, s.policy, { id: 'perm_nope', choice: 'allow' }, 'human', s.now()).status).toBe(404)
  expect(decidePermission(s.db, s.policy, { id: 'x', choice: 'maybe' }, 'human', s.now()).status).toBe(400)
  s.onFirstWait((id) => {
    expect(decidePermission(s.db, s.policy, { id, choice: 'always' }, 'human', s.now())).toMatchObject({ status: 400, body: { error: 'no_safe_pattern' } })
    decidePermission(s.db, s.policy, { id, choice: 'deny' }, 'human', s.now())
    expect(decidePermission(s.db, s.policy, { id, choice: 'allow' }, 'human', s.now()).status).toBe(409)
  })
  await answerPermission(s.deps, ask('rm *'))
})

test('no project or wait disabled: no inbox item, no decision', async () => {
  const s = setup()
  expect(await answerPermission({ ...s.deps, projectId: null }, ask('ls'))).toBeNull()
  expect(await answerPermission({ ...s.deps, waitMs: 0 }, ask('ls'))).toBeNull()
  expect(rows(s.db, 'SELECT COUNT(*) AS n FROM approval')[0].n).toBe(0)
})

test('HTTP /api/approvals/permission: the page lists and decides; an agent credential is refused', async () => {
  const s = setup()
  const runtime = { mode: 'on', path: ':memory:', db: s.db, ledger: createLedger(s.db, { now: s.now }), close() {} } as unknown as LedgerRuntime
  const call = async (method: string, headers: Record<string, string>, payload?: unknown) => {
    const r = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage
    r.method = method
    r.headers = headers
    const out = { statusCode: 0, payload: '', setHeader() {}, end(d = '') { out.payload = d } }
    await approvalHumanRoute(r, out as unknown as ServerResponse, new URL('http://x/api/approvals/permission'), { runtime, now: s.now, isNodeToken: (t) => t === 'node-tok' })
    return { status: out.statusCode, json: (out.payload ? JSON.parse(out.payload) : {}) as { items?: Array<{ id: string; label: string }> } }
  }
  const page = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }
  const seen = { label: '', agent: 0, page: 0 }
  let done = false
  const tick = s.deps.sleep
  s.deps.sleep = async (ms) => {
    if (!done) {
      done = true
      const id = (await call('GET', page)).json.items?.[0]?.id ?? ''
      seen.label = (await call('GET', page)).json.items?.[0]?.label ?? ''
      seen.agent = (await call('POST', { ...page, 'x-webterm-token': 'node-tok' }, { id, choice: 'allow' })).status
      seen.page = (await call('POST', page, { id, choice: 'allow' })).status
    }
    await tick?.(ms)
  }
  const out = await answerPermission(s.deps, ask('npm publish'))
  expect(seen).toEqual({ label: 'Bash(npm publish)', agent: 403, page: 200 })
  expect(out?.hookSpecificOutput.decision.behavior).toBe('allow')
})
