// Bun integration: the control approval route's replay window must survive a runtime reopen.
// `mount.ts` passes `acks: durableAckFor(runtime.db, 'control')`; without it the ack store is
// rebuilt per ledger port, so a retried requestId mints a second approval after a restart (QC S4).

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings } from '../../shared/settings'
import { allows, clampTtl } from './capabilities'
import { capabilityStore, handleControlHttp } from './mount'
import type { ControlDeps } from './controlTypes'
import {
  resetActiveLedgerRuntimeForTest,
  startLedgerRuntime,
} from '../ledger/ledgerRuntime'

const REQ = 'req-durable-01'
const root = mkdtempSync(join(tmpdir(), 'control-approval-ack-'))

afterAll(() => {
  resetActiveLedgerRuntimeForTest()
  rmSync(root, { recursive: true, force: true })
})

function deps(): ControlDeps {
  return {
    sessions: {
      open() {},
      input() {},
      close() {},
      list: () => [],
      statusOf: () => undefined,
      getExit: () => undefined,
      getTerminal: () => '',
      isLive: () => false,
    },
    capabilities: {
      verify: (token, now = Date.now()) => capabilityStore.verify(token, now),
      allows,
      mint: (options) => ({
        token: capabilityStore.mint(options),
        expiresAt: Date.now() + clampTtl(options.ttlMs),
      }),
    },
    settings: () => mergeSettings({}),
  }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(data = '') {
      this.body = data
    },
  }
}

async function post(body: unknown, token: string) {
  const res = fakeRes()
  const handled = await handleControlHttp(
    { method: 'POST', headers: { 'x-webterm-capability': token } } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL('/api/control/approval/request', 'http://x'),
    async () => JSON.stringify(body),
    deps()
  )
  return { handled, status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

test('an approval request requestId replays across a ledger runtime reopen', async () => {
  const path = join(root, 'ledger.db')
  const first = startLedgerRuntime({ mode: 'on', path })
  expect(first).not.toBe(null)
  first!.ledger.project.createProject({
    id: 'p1',
    workspaceId: 'w1',
    name: 'p1',
    path: '/tmp/p1',
  })

  const token = capabilityStore.mint({ verb: 'approval.request', resource: 'project:p1' })
  const payload = {
    requestId: REQ,
    projectId: 'p1',
    kind: 'git.push',
    request: { branch: 'main' },
  }

  const created = await post(payload, token)
  expect(created.status).toBe(201)
  expect(first!.ledger.approval.listApprovals({ projectId: 'p1' }).length).toBe(1)

  first!.close()
  resetActiveLedgerRuntimeForTest()
  const reopened = startLedgerRuntime({ mode: 'on', path })
  expect(reopened).not.toBe(null)

  const replay = await post(payload, token)
  expect(replay.status).toBe(201)
  expect(JSON.stringify(replay.json)).toBe(JSON.stringify(created.json))
  // Replay, not a second challenge: the durable journal kept the original ack across the restart.
  expect(reopened!.ledger.approval.listApprovals({ projectId: 'p1' }).length).toBe(1)

  reopened!.close()
})
