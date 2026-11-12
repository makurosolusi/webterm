import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { centralChatRoute, type CentralChatDeps } from './centralChatApi'
import { onceWarn, runtimeReadiness } from './centralChatHealth'
import { openFixture, seedPortfolio, type Fixture } from './central/centralTestFixture.testutil'
import type { RuntimeKind } from './central/runtime/centralRuntime'
import type { ClaudeReady } from './central/runtime/claudeOptions'
import type { ClaudeReady as PreflightReady } from './central/runtime/claudePreflight'
import { successRecords, waitFor } from './central/runtime/claude.fakeBin'
import { fakeQuery } from './central/runtime/claude.fakeQuery'
import { logBus } from './logs/logBus'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

const NOT_LOGGED_IN: ClaudeReady = { ok: false, code: 'claude_not_authenticated', hint: 'login' }
const WAIT_MS = 5_000

// The two structurally identical ClaudeReady declarations must stay assignable both ways.
const fromOptions: ClaudeReady = { ok: true } satisfies PreflightReady
const fromPreflight: PreflightReady = fromOptions satisfies ClaudeReady

let fixture: Fixture
let ledger: LedgerRuntime
let dir: string

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  ledger = { db: fixture.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
  dir = mkdtempSync(join(tmpdir(), 'central-claude-wiring-'))
})
afterEach(() => {
  fixture.close()
  rmSync(dir, { recursive: true, force: true })
})

function deps(runtimeKind: RuntimeKind, overrides: Partial<CentralChatDeps> = {}): CentralChatDeps {
  return { ledger, chatEnabled: true, centralEnabled: true, runtimeKind, ...overrides }
}

async function call(d: CentralChatDeps, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = body === undefined ? 'GET' : 'POST'
  req.headers = {}
  let payload = ''
  const res = {
    statusCode: 200, setHeader() {}, end(data = '') { payload += data }, on() { return res }, write() {},
  }
  await centralChatRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), d)
  return { status: res.statusCode, json: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

const MESSAGES = '/api/central/conversations/central%3Aglobal/messages'
const turnRow = () => fixture.db.query('SELECT status, error_code FROM central_turn').get() as { status: string; error_code: string | null } | null

describe('claude wiring: health', () => {
  it('reports runtimeReady from the preflight for claude', async () => {
    const ok = await call(deps('claude', { claudeOptions: { preflight: async () => ({ ok: true }) } }), '/api/central/health')
    expect(ok.json).toEqual({ runtime: 'claude', chat: true, ledger: true, runtimeReady: true })
    const bad = await call(deps('claude', { claudeOptions: { preflight: async () => NOT_LOGGED_IN } }), '/api/central/health')
    expect(bad.json).toEqual({
      runtime: 'claude', chat: true, ledger: true, runtimeReady: false, runtimeIssue: 'claude_not_authenticated',
    })
  })

  it('maps a throwing preflight to claude_check_failed and never probes for other kinds', async () => {
    const boom = async (): Promise<ClaudeReady> => { throw new Error('boom') }
    await expect(runtimeReadiness('claude', boom)).resolves.toEqual({ runtimeReady: false, runtimeIssue: 'claude_check_failed' })
    await expect(runtimeReadiness('off', boom)).resolves.toEqual({ runtimeReady: false })
    await expect(runtimeReadiness('mock', boom)).resolves.toEqual({ runtimeReady: true })
  })

  it('warns once per distinct cause, with stage, profile and timing', async () => {
    const seen: Array<Record<string, unknown>> = []
    const off = logBus.subscribe((entry) => { if (entry.event === 'central.runtime_unready') seen.push(entry.data as Record<string, unknown>) })
    let ready: ClaudeReady = { ...NOT_LOGGED_IN, stage: 'auth', failed: 'auth_failed', profile: { id: 'p1', name: 'Mine' }, elapsedMs: 12, timedOut: false }
    const wrapped = onceWarn(async () => ready)
    await wrapped()
    await wrapped()
    ready = { ok: false, code: 'claude_check_failed', hint: 'slow', stage: 'wrapper', failed: 'wrapper_failed', profile: { id: 'p1', name: 'Mine' }, timedOut: true }
    await wrapped()
    off()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ code: 'claude_not_authenticated', stage: 'auth', failed: 'auth_failed', profileId: 'p1', elapsedMs: 12, timedOut: false })
    expect(seen[1]).toMatchObject({ stage: 'wrapper', timedOut: true })
    expect(fromPreflight).toEqual({ ok: true })
  })
})

describe('claude wiring: chat service', () => {
  it('builds a real runtime for claude: an unready CLI fails the turn, not the request', async () => {
    const fake = fakeQuery(successRecords())
    const claudeOptions = { query: fake.query, workDir: join(dir, 'work'), preflight: async () => NOT_LOGGED_IN }
    const accepted = await call(deps('claude', { claudeOptions }), MESSAGES, { clientMessageId: 'c1', text: 'hi' })
    expect(accepted.status).toBe(202)
    await waitFor(() => turnRow()?.status === 'failed', WAIT_MS)
    expect(turnRow()?.error_code).toBe('runtime_unavailable')
    expect(fake.calls).toHaveLength(0)
  })

  it('streams a fake claude turn to success', async () => {
    const claudeOptions = { query: fakeQuery(successRecords()).query, workDir: join(dir, 'work'), preflight: async () => ({ ok: true as const }) }
    const accepted = await call(deps('claude', { claudeOptions }), MESSAGES, { clientMessageId: 'c2', text: 'hi' })
    expect(accepted.status).toBe(202)
    await waitFor(() => turnRow()?.status === 'succeeded', WAIT_MS)
    const messages = await call(deps('claude', { claudeOptions }), `${MESSAGES}?limit=10`)
    expect(JSON.stringify(messages.json)).toContain('Hello world')
  })

  it('keeps off as 503 and mock unchanged', async () => {
    const off = await call(deps('off'), MESSAGES, { clientMessageId: 'c3', text: 'hi' })
    expect(off.status).toBe(503)
    expect((off.json['error'] as { code: string }).code).toBe('central_runtime_off')
    const mock = await call(deps('mock'), MESSAGES, { clientMessageId: 'c4', text: 'hi' })
    expect(mock.status).toBe(202)
  })
})
