// Vitest: penyambungan keluarga `/api/control/approval/*` ke `mount.ts` tanpa `bun:sqlite`.
// Port ledger di-inject lewat runtime palsu; `activeLedgerRuntime` adalah satu-satunya sumber,
// jadi test ini membuktikan 503 (ledger off), 401 (tanpa capability), dan query list yang utuh.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeSettings } from '../../shared/settings'
import { allows, clampTtl } from './capabilities'
import { capabilityStore, handleControlHttp } from './mount'
import type { ApprovalLedgerPort } from './approvalApi'
import type { ControlDeps } from './controlTypes'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { resetActiveLedgerRuntimeForTest, setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'

const REQ = 'req-00000001'

const listCalls: unknown[] = []
const approvalPort: ApprovalLedgerPort = {
  requestApproval() {
    throw new Error('not used')
  },
  getApproval: () => null,
  decideApproval() {
    throw new Error('not used')
  },
  consumeApproval: () => false,
  listApprovals(options) {
    listCalls.push(options)
    return []
  },
}

function fakeRuntime(port: ApprovalLedgerPort | undefined = approvalPort): LedgerRuntime {
  return { mode: 'on', path: ':memory:', db: {}, ledger: { approval: port } } as unknown as LedgerRuntime
}

afterEach(() => resetActiveLedgerRuntimeForTest())

interface FakeRes {
  statusCode: number
  body: string
  setHeader(name: string, value: string): void
  end(data?: string): void
}

function fakeRes(): FakeRes {
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
      screenSource: () => undefined,
      agentIdOf: () => undefined,
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

async function call(method: string, path: string, body = '', headers: Record<string, string> = {}) {
  const res = fakeRes()
  const handled = await handleControlHttp(
    fakeReq(method, headers),
    res as unknown as ServerResponse,
    new URL(path, 'http://x'),
    async () => body,
    deps()
  )
  return { handled, res, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

describe('approval dispatch through the control mount', () => {
  it('answers 503 ledger_off for every approval path when no runtime is active', async () => {
    resetActiveLedgerRuntimeForTest()
    const list = await call('GET', '/api/control/approval/list?projectId=p1')
    expect(list.handled).toBe(true)
    expect(list.res.statusCode).toBe(503)
    expect(list.json).toEqual({ error: 'ledger_off' })

    const request = await call('POST', '/api/control/approval/request', '{}')
    expect(request.res.statusCode).toBe(503)
  })

  it('rejects an approval request with no capability token', async () => {
    setActiveLedgerRuntime(fakeRuntime())
    const call1 = await call(
      'POST',
      '/api/control/approval/request',
      JSON.stringify({ requestId: REQ, projectId: 'p1', kind: 'git.push', request: {} })
    )
    expect(call1.res.statusCode).toBe(401)
    expect(call1.json).toEqual({ error: 'unauthorized' })
  })

  it('preserves the query string for GET list and enforces the read capability', async () => {
    setActiveLedgerRuntime(fakeRuntime())
    const read = capabilityStore.mint({ verb: 'approval.read', resource: 'project:p1' })
    listCalls.length = 0
    const result = await call('GET', '/api/control/approval/list?projectId=p1&status=pending&limit=5', '', {
      'x-webterm-capability': read,
    })
    expect(result.res.statusCode).toBe(200)
    expect(result.json).toEqual([])
    expect(listCalls).toEqual([{ projectId: 'p1', status: 'pending', limit: 5 }])

    // No query at all must still be a 400 from the handler (mount did not invent a project).
    const missing = await call('GET', '/api/control/approval/list', '', {
      'x-webterm-capability': read,
    })
    expect(missing.res.statusCode).toBe(400)
    expect(missing.json).toEqual({ error: 'missing_project_id' })
  })

  it('replays a requestId across HTTP calls (stable deps identity)', async () => {
    // Production builds the dispatch deps per request. Before the fix that gave every request a
    // fresh AckStore, so the 10-minute window never existed (QC H2/B1).
    let created = 0
    const port: ApprovalLedgerPort = {
      requestApproval: () => {
        created += 1
        return { id: `ap-${created}`, digest: 'd', nonce: `n-${created}`, expiresAt: 1 }
      },
      getApproval: () => null,
      decideApproval() {
        throw new Error('not used')
      },
      consumeApproval: () => false,
      listApprovals: () => [],
    }
    setActiveLedgerRuntime(fakeRuntime(port))
    const token = capabilityStore.mint({ verb: 'approval.request', resource: 'project:p1' })
    const body = JSON.stringify({
      requestId: REQ,
      projectId: 'p1',
      kind: 'git.push',
      request: { branch: 'main' },
    })
    const first = await call('POST', '/api/control/approval/request', body, {
      'x-webterm-capability': token,
    })
    const second = await call('POST', '/api/control/approval/request', body, {
      'x-webterm-capability': token,
    })
    expect(created).toBe(1)
    expect(second.json).toEqual(first.json)
  })

  it('leaves non-approval control routes to the existing router', async () => {
    setActiveLedgerRuntime(fakeRuntime())
    // No root token configured in these deps: the token route is absent (404), not 503.
    const result = await call('POST', '/api/control/token', '{}')
    expect(result.handled).toBe(true)
    expect(result.res.statusCode).toBe(404)
    expect(result.json).toEqual({ error: 'not_found' })
  })
})
