import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Ledger } from '../ledger/ledger'
import type { ApprovalSummary } from './channelDispatch'
import {
  TELEGRAM_WEBHOOK_PATH,
  handleTelegramWebhook,
  startChannelsRuntime,
  type ChannelWebhookRequest,
  type ChannelWebhookRuntime,
} from './channelsRuntime'
import { TELEGRAM_SECRET_HEADER } from './webhook'

const SECRET = 'webhook-secret-for-tests'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-http-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

const UPDATE = {
  update_id: 1,
  message: { message_id: 1, text: '/status', chat: { id: 5, type: 'private' }, from: { id: 7 } },
}

function request(overrides: Partial<ChannelWebhookRequest> = {}): ChannelWebhookRequest {
  return {
    method: 'POST',
    headers: { [TELEGRAM_SECRET_HEADER]: SECRET },
    readBody: async () => ({ ok: true, body: JSON.stringify(UPDATE) }),
    ...overrides,
  }
}

function runtime(
  dispatch = vi.fn(async () => ({ status: 'handled' as const, command: 'status' as const, reply: null }))
): ChannelWebhookRuntime {
  return { secret: SECRET, dispatch }
}

describe('handleTelegramWebhook', () => {
  it('rejects a wrong secret_token with 401 and dispatches nothing', async () => {
    const dispatch = vi.fn()
    const result = await handleTelegramWebhook(
      request({ headers: { [TELEGRAM_SECRET_HEADER]: 'wrong-secret' } }),
      runtime(dispatch as never)
    )
    expect(result).toEqual({ status: 401, body: { ok: false, error: 'bad_secret_token' } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects a missing and an oversized declared body before reading it', async () => {
    const readBody = vi.fn(async () => ({ ok: true as const, body: '{}' }))
    const missing = await handleTelegramWebhook(request({ headers: {}, readBody }), runtime())
    expect(missing.status).toBe(401)

    const oversized = await handleTelegramWebhook(request({ declaredLength: 64 * 1024 + 1, readBody }), runtime())
    expect(oversized).toEqual({ status: 413, body: { ok: false, error: 'body_too_large' } })
    expect(readBody).not.toHaveBeenCalled()
  })

  it('rejects a chunked body that grows past the cap', async () => {
    const result = await handleTelegramWebhook(
      request({ readBody: async () => ({ ok: false, reason: 'too_large' }) }),
      runtime()
    )
    expect(result.status).toBe(413)
  })

  it('accepts a valid update, reports duplicates, and never leaks a dispatch error', async () => {
    const dispatch = vi.fn(async () => ({ status: 'duplicate' as const, updateId: 1 }))
    expect(await handleTelegramWebhook(request(), runtime(dispatch as never))).toEqual({
      status: 200,
      body: { ok: true, duplicate: true },
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(async () => {
      throw new Error('boom https://api.telegram.org/bot123456:SECRET-TOKEN-VALUE/sendMessage')
    })
    const failed = await handleTelegramWebhook(request(), runtime(failing as never))
    expect(failed).toEqual({ status: 500, body: { ok: false, error: 'internal_error' } })
    expect(JSON.stringify(failed)).not.toContain('SECRET-TOKEN-VALUE')
    expect(JSON.stringify(failed)).not.toContain('boom')
    for (const call of errorSpy.mock.calls) expect(String(call[0])).not.toContain('SECRET-TOKEN-VALUE')
    errorSpy.mockRestore()
  })

  it('rejects the wrong method and malformed JSON without dispatching', async () => {
    expect((await handleTelegramWebhook(request({ method: 'GET' }), runtime())).status).toBe(405)
    expect(
      (await handleTelegramWebhook(request({ readBody: async () => ({ ok: true, body: '{' }) }), runtime())).status
    ).toBe(400)
  })
})

interface FakeLedger {
  ledger: Ledger
  decided: Array<{ id: string; input: unknown }>
  approvals: Map<string, ApprovalSummary>
}

function fakeLedger(): FakeLedger {
  const approvals = new Map<string, ApprovalSummary>([
    ['ap1', { id: 'ap1', projectId: 'p1', status: 'pending' }],
  ])
  const decided: Array<{ id: string; input: unknown }> = []
  const ledger = {
    approval: {
      listApprovals: () => [...approvals.values()],
      getApproval: (id: string) => approvals.get(id) ?? null,
      decideApproval: (id: string, input: { approve: boolean }) => {
        decided.push({ id, input })
        const row = approvals.get(id)
        if (row) row.status = input.approve ? 'approved' : 'rejected'
        return row
      },
      consumeApproval: () => true,
    },
    event: { appendEvent: () => ({ seq: 1 }) },
  } as unknown as Ledger
  return { ledger, decided, approvals }
}

function fakeHttp(): { req: IncomingMessage; res: ServerResponse; done: Promise<{ status: number; body: string }> } {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', url: TELEGRAM_WEBHOOK_PATH, headers: { [TELEGRAM_SECRET_HEADER]: SECRET } })
  let resolveDone: (value: { status: number; body: string }) => void = () => {}
  const done = new Promise<{ status: number; body: string }>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader: () => undefined,
    end: (body: string) => resolveDone({ status: res.statusCode, body }),
  } as unknown as ServerResponse
  return { req, res, done }
}

describe('startChannelsRuntime', () => {
  it('installs no route when the flag is off, the secret is missing, or the ledger is off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(startChannelsRuntime(undefined, { env: {} })).toBeNull()
    expect(
      startChannelsRuntime(undefined, { env: { WEBTERM_TELEGRAM: 'on' } as NodeJS.ProcessEnv })
    ).toBeNull()
    expect(
      startChannelsRuntime(undefined, {
        env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv,
      })
    ).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails closed and logs no file content when the store is corrupt', () => {
    const storePath = tempStorePath()
    mkdirSync(join(storePath, '..'), { recursive: true })
    writeFileSync(storePath, '{"version":1,"secret":"bot123:SECRET-VALUE"}')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeOrNull = startChannelsRuntime(fakeLedger().ledger, {
      env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv,
      storePath,
    })
    expect(runtimeOrNull).toBeNull()
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('corrupt')
    expect(logged).not.toContain('SECRET-VALUE')
    warn.mockRestore()
  })

  it('serves only its exact path and dispatches a signed update once', async () => {
    const fake = fakeLedger()
    const storePath = tempStorePath()
    const channels = startChannelsRuntime(fake.ledger, {
      env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv,
      storePath,
    })
    expect(channels).not.toBeNull()
    if (!channels) return
    channels.store.bind('telegram', '5', { projectId: 'p1', role: 'approver', userId: '7' })

    const other = fakeHttp()
    Object.assign(other.req, { url: '/api/status' })
    expect(channels.handle(other.req, other.res)).toBe(false)

    const approveBody = JSON.stringify({
      update_id: 2,
      message: {
        message_id: 2,
        text: '/approve ap1 ' + 'a'.repeat(64) + ' 11111111-2222-3333-4444-555555555555',
        chat: { id: 5, type: 'private' },
        from: { id: 7 },
      },
    })
    const { req, res, done } = fakeHttp()
    expect(channels.handle(req, res)).toBe(true)
    req.emit('data', Buffer.from(approveBody))
    req.emit('end')
    const response = await done
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true })
    expect(fake.decided).toHaveLength(1)

    // Replaying the same update_id over the same store is a no-op.
    const replay = fakeHttp()
    expect(channels.handle(replay.req, replay.res)).toBe(true)
    replay.req.emit('data', Buffer.from(approveBody))
    replay.req.emit('end')
    expect(JSON.parse((await replay.done).body)).toEqual({ ok: true, duplicate: true })
    expect(fake.decided).toHaveLength(1)
  })
})
