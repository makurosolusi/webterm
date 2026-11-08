// Bun-only. Skip approvals on Central's MCP path: a pending card no longer blocks the call, a rejected one still does.
import { expect, test } from 'bun:test'
import { obj, S } from '../capability/capability.schema'
import { createControlGuard } from '../central/guard/controlGuard'
import { freshDb, rows } from '../central/guard/controlGuard.testutil'
import { createRegistry } from '../central/tools/toolRegistry'
import type { ToolDef } from '../central/tools/toolTypes'
import { decideApproval } from '../ledger/ledgerApproval'
import { callCentralTool, type CentralMcpDeps } from './mcp.central'

function setup() {
  const db = freshDb()
  const ran: string[] = []
  const deploy: ToolDef = {
    name: 'test.deploy', summary: 'test-only R2 effect', tier: 'R2', usage: '{}',
    input: obj({ target: S.str(40) }, ['target']), output: S.anyObj('deployed'), validate: () => null,
    handler: (_ctx, input) => { ran.push(String(input.target)); return { ok: true, data: { deployed: input.target } } },
  }
  const registry = createRegistry()
  registry.register(deploy)
  const flag = { on: false }
  const guard = createControlGuard({ db, now: Date.now, env: { WEBTERM_CENTRAL_AGENTS: 'propose' }, skipApprovals: () => flag.on })
  const deps: CentralMcpDeps = { db, registry, env: {}, guard, secretValues: () => [] }
  const call = (target: string) => callCentralTool(deps, 'central:global', 'test_deploy', { projectId: 'p1', target })
  const reject = (id: string) => {
    const card = rows(db, 'SELECT d.action_digest AS digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', id)[0]
    decideApproval({ db, now: Date.now }, id, { approve: false, actor: 'human:alice', digest: String(card?.digest), nonce: String(card?.nonce) })
  }
  return { flag, ran, call, reject }
}
const approvalId = (r: { data: unknown }) => (r.data as { approvalId: string }).approvalId

test('skip off: the call waits on its card; skip on: the same pending call runs', async () => {
  const { flag, ran, call } = setup()
  const first = await call('prod')
  expect(first).toMatchObject({ outcome: 'denied', detail: 'approval_required', data: { status: 'pending' } })
  expect(await call('prod')).toMatchObject({ detail: 'approval_required', data: { approvalId: approvalId(first) } })
  expect(ran).toEqual([])
  flag.on = true
  expect(await call('prod')).toMatchObject({ outcome: 'ok', data: { deployed: 'prod' } })
  expect(ran).toEqual(['prod'])
})

test('skip on: a fresh call runs without any card', async () => {
  const { flag, ran, call } = setup()
  flag.on = true
  expect(await call('canary')).toMatchObject({ outcome: 'ok', data: { deployed: 'canary' } })
  expect(ran).toEqual(['canary'])
})

test('skip on still respects a card the human rejected', async () => {
  const { flag, ran, call, reject } = setup()
  const first = await call('staging')
  reject(approvalId(first))
  flag.on = true
  expect(await call('staging')).toMatchObject({ outcome: 'denied', detail: 'approval_rejected' })
  expect(ran).toEqual([])
})
