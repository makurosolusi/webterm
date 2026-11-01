// Bun integration: route modules + approval dispatch against a REAL ledger DB (bun:sqlite).
// Vitest covers the same wiring with a node:sqlite adapter; this file proves the production
// runtime singleton really is what `mount.ts` and the new GET routes read.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboxRoute } from './inboxApi'
import { memoryRoute } from './memoryApi'
import { orchestratorRoute } from './orchestratorApi'
import { claimMemory, promoteMemory } from './memory/memory'
import { createPlanStore } from './orchestrator/plan'
import { capabilityStore, handleControlHttp } from './control/mount'
import { allows, clampTtl } from './control/capabilities'
import { mergeSettings } from '../shared/settings'
import type { ControlDeps } from './control/controlTypes'
import {
  activeLedgerRuntime,
  resetActiveLedgerRuntimeForTest,
  startLedgerRuntime,
} from './ledger/ledgerRuntime'

const NOW = Date.now()

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

const fakeReq = (method: string, headers: Record<string, string> = {}) =>
  ({ method, headers }) as unknown as IncomingMessage

function controlDeps(rootToken?: string): ControlDeps {
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
    rootToken,
    allowTokenMint: rootToken !== undefined,
  }
}

async function controlPost(path: string, body: unknown, headers: Record<string, string> = {}, root?: string) {
  const res = fakeRes()
  const handled = await handleControlHttp(
    fakeReq('POST', headers),
    res as unknown as ServerResponse,
    new URL(path, 'http://x'),
    async () => JSON.stringify(body),
    controlDeps(root)
  )
  return { handled, status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

test('read routes and approval dispatch run against the real ledger runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-ledger-routes-'))
  const runtime = startLedgerRuntime({ mode: 'on', path: join(dir, 'ledger.db') })
  expect(runtime).not.toBe(null)
  expect(activeLedgerRuntime()).toBe(runtime)
  const ledger = runtime!.ledger

  try {
    ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'Alpha', path: '/tmp/a' })
    const task = ledger.task.createTask({ projectId: 'p1', spec: 'blocked task' })
    ledger.task.blockTask(task.id, 'needs a human')
    ledger.approval.requestApproval({
      projectId: 'p1',
      kind: 'git.push',
      request: { branch: 'main' },
      ttlMs: 60_000,
    })
    ledger.agent.createAgent({ id: 'ag1', projectId: 'p1', role: 'orchestrator', depth: 0 })
    createPlanStore(runtime!.db).create({ projectId: 'p1', items: [{ title: 'ship it', scope: ['src/server'] }] })

    // Authority is server-derived (QC M2); the test acts as the worker.
    const claim = claimMemory(runtime!.db, { kind: 'worker', id: 'worker-1' }, {
      projectId: 'p1',
      key: 'deploy',
      title: 'Deploy',
      body: 'deploy uses bun',
      sourceKind: 'file',
      sourceRef: 'README.md',
      now: NOW,
    })
    promoteMemory(runtime!.db, { kind: 'orchestrator', id: 'orchestrator-1' }, {
      id: claim.id,
      evidence: { command: 'bun test src/server/memory', exitCode: 0, observedAt: NOW },
      now: NOW,
    })

    const inbox = inboxRoute('/api/inbox', 'GET', new URLSearchParams('projectId=p1'), runtime)
    expect(inbox?.status).toBe(200)
    const inboxBody = inbox?.body as { items: { kind: string }[]; counts: { needsYou: number } }
    expect(inboxBody.items.some((item) => item.kind === 'approval')).toBe(true)
    expect(inboxBody.items.some((item) => item.kind === 'task')).toBe(true)
    expect(inboxBody.counts.needsYou).toBe(2)

    const search = memoryRoute('/api/memory/search', 'GET', new URLSearchParams('projectId=p1&q=deploy'), runtime)
    expect(search?.status).toBe(200)
    const searchItems = (search?.body as { items: { status: string }[] }).items
    expect(searchItems.length).toBe(1)
    expect(searchItems[0].status).toBe('fact')
    const list = memoryRoute('/api/memory', 'GET', new URLSearchParams('projectId=p1'), runtime)
    expect((list?.body as { items: unknown[] }).items.length).toBe(1)

    const tasks = orchestratorRoute('/api/orchestrator/tasks', 'GET', new URLSearchParams('projectId=p1'), runtime)
    const taskIds = (tasks?.body as { tasks: { id: string }[] }).tasks.map((row) => row.id)
    expect(taskIds.length).toBe(1)
    expect(taskIds[0]).toBe(task.id)
    const agents = orchestratorRoute('/api/orchestrator/agents', 'GET', new URLSearchParams('projectId=p1'), runtime)
    const agentIds = (agents?.body as { agents: { id: string }[] }).agents.map((row) => row.id)
    expect(agentIds.length).toBe(1)
    expect(agentIds[0]).toBe('ag1')
    const plan = orchestratorRoute('/api/orchestrator/plan', 'GET', new URLSearchParams('projectId=p1'), runtime)
    expect((plan?.body as { plan: { projectId: string } | null }).plan?.projectId).toBe('p1')

    // Capability minted through the root token route, then used on the approval request route.
    const minted = await controlPost(
      '/api/control/token',
      { verb: 'approval.request', resource: 'project:p1' },
      { 'x-webterm-token': 'root-secret' },
      'root-secret'
    )
    expect(minted.status).toBe(201)
    const capability = (minted.json as { token: string }).token

    const unauthorized = await controlPost('/api/control/approval/request', {
      requestId: 'req-00000001',
      projectId: 'p1',
      kind: 'git.push',
      request: { branch: 'main' },
    })
    expect(unauthorized.status).toBe(401)

    const approved = await controlPost(
      '/api/control/approval/request',
      { requestId: 'req-00000002', projectId: 'p1', kind: 'git.push', request: { branch: 'main' } },
      { 'x-webterm-capability': capability },
      'root-secret'
    )
    expect(approved.status).toBe(201)
    expect(typeof (approved.json as { id: string }).id).toBe('string')

    resetActiveLedgerRuntimeForTest()
    const off = await controlPost('/api/control/approval/request', {}, {}, 'root-secret')
    expect(off.status).toBe(503)
    expect((off.json as { error: string }).error).toBe('ledger_off')
  } finally {
    resetActiveLedgerRuntimeForTest()
    runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
