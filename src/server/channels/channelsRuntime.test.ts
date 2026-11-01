import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Ledger } from '../ledger/ledger'
import type { ApprovalSummary } from './channelDispatch'
import {
  MIN_WEBHOOK_SECRET_CHARS,
  TELEGRAM_WEBHOOK_PATH,
  handleTelegramWebhook,
  startChannelsRuntime,
  type ChannelsRuntime,
  type ChannelWebhookRequest,
  type ChannelWebhookRuntime,
} from './channelsRuntime'
import { TELEGRAM_SECRET_HEADER } from './webhook'

// >= MIN_WEBHOOK_SECRET_CHARS; the runtime refuses anything shorter (QC M3).
const SECRET = 'webhook-secret-for-tests-0123456789'
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

function fakeHttp(
  headers: Record<string, string> = { [TELEGRAM_SECRET_HEADER]: SECRET }
): {
  req: IncomingMessage
  res: ServerResponse
  done: Promise<{ status: number; body: string; headers: Record<string, string> }>
} {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method: 'POST',
    url: TELEGRAM_WEBHOOK_PATH,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    resume: () => undefined,
  })
  const sent: Record<string, string> = {}
  let resolveDone: (value: { status: number; body: string; headers: Record<string, string> }) => void =
    () => {}
  const done = new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      sent[name.toLowerCase()] = value
    },
    end: (body: string) => resolveDone({ status: res.statusCode, body, headers: sent }),
  } as unknown as ServerResponse
  return { req, res, done }
}

/** Drive one real webhook request through the installed route. */
async function postWebhook(
  channels: ChannelsRuntime,
  payload: unknown,
  headers: Record<string, string> = { [TELEGRAM_SECRET_HEADER]: SECRET }
): Promise<{ handled: boolean; status: number; body: string; headers: Record<string, string> }> {
  const { req, res, done } = fakeHttp(headers)
  const handled = channels.handle(req, res)
  req.emit('data', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)))
  req.emit('end')
  return { handled, ...(await done) }
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

describe('channel secret source', () => {
  const flagOn = (extra: Record<string, string>): NodeJS.ProcessEnv =>
    ({ WEBTERM_TELEGRAM: 'on', ...extra }) as NodeJS.ProcessEnv

  it('reads no secret at all when the flag is off, and installs no route', () => {
    const readSecret = vi.fn(() => ({ ok: true as const, text: SECRET }))
    const runtimeOrNull = startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM: 'off', WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: '/nonexistent/secret' }),
      readSecret,
      storePath: tempStorePath(),
    })
    expect(runtimeOrNull).toBeNull()
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('refuses a secret shorter than the minimum from env and from a file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const short = 'a'.repeat(MIN_WEBHOOK_SECRET_CHARS - 1)
    expect(startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET: short }),
      storePath: tempStorePath(),
    })).toBeNull()
    // A 1-character secret is the exact defect QC M3 reported.
    expect(startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET: 'x' }),
      storePath: tempStorePath(),
    })).toBeNull()
    expect(startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: '/tmp/x' }),
      readSecret: () => ({ ok: true, text: short }),
      storePath: tempStorePath(),
    })).toBeNull()
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain(String(MIN_WEBHOOK_SECRET_CHARS))
    expect(logged).not.toContain(short)
    warn.mockRestore()
  })

  it('accepts a 0600 secret file and rejects newline/whitespace and mode problems', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = mkdtempSync(join(tmpdir(), 'webterm-secret-'))
    dirs.push(root)
    const secretPath = join(root, 'telegram-secret')
    writeFileSync(secretPath, `${SECRET}\n`, { mode: 0o600 })
    chmodSync(secretPath, 0o600)

    const fromFile = startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: secretPath }),
      storePath: tempStorePath(),
    })
    expect(fromFile).not.toBeNull()

    // World-readable file: not a secret, so the channel stays off (fail closed).
    chmodSync(secretPath, 0o644)
    expect(startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: secretPath }),
      storePath: tempStorePath(),
    })).toBeNull()
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('0600')

    // A missing file is a startup failure, never a silent default.
    expect(startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: join(root, 'absent') }),
      storePath: tempStorePath(),
    })).toBeNull()
    warn.mockRestore()
  })

  it('refuses a secret file whose content has internal whitespace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = mkdtempSync(join(tmpdir(), 'webterm-secret-'))
    dirs.push(root)
    const secretPath = join(root, 'secret-with-space')
    writeFileSync(secretPath, `${SECRET.slice(0, 20)} ${SECRET.slice(20)}`, { mode: 0o600 })
    chmodSync(secretPath, 0o600)
    expect(startChannelsRuntime(fakeLedger().ledger, {
      env: flagOn({ WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: secretPath }),
      storePath: tempStorePath(),
    })).toBeNull()
    warn.mockRestore()
  })
})

describe('channel route surface', () => {
  function liveRuntime(now = () => 1_700_000_000_000): { channels: ChannelsRuntime; fake: FakeLedger } {
    const fake = fakeLedger()
    const channels = startChannelsRuntime(fake.ledger, {
      env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv,
      storePath: tempStorePath(),
      now,
    })
    expect(channels).not.toBeNull()
    if (!channels) throw new Error('channel runtime did not start')
    return { channels, fake }
  }

  it('claims exactly the webhook path and nothing else', () => {
    const { channels } = liveRuntime()
    for (const path of ['/api/status', '/webhooks', '/webhooks/telegram/x', '/webhooks/telegram/']) {
      const { req, res } = fakeHttp()
      Object.assign(req, { url: path })
      expect(channels.handle(req, res)).toBe(false)
    }
    const { req, res } = fakeHttp()
    expect(channels.handle(req, res)).toBe(true)
    res.end('')
  })

  it('caps a chunked body at 64 KiB before any parse, without echoing the body', async () => {
    const { channels, fake } = liveRuntime()
    const huge = JSON.stringify({
      update_id: 99,
      message: { message_id: 1, text: 'x'.repeat(70 * 1024), chat: { id: 5, type: 'private' }, from: { id: 7 } },
    })
    const response = await postWebhook(channels, huge)
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: 'body_too_large' })
    expect(response.body).not.toContain('xxxxx')
    expect(fake.decided).toHaveLength(0)
  })

  it('denies a group chat end to end and never reaches the ledger', async () => {
    const { channels, fake } = liveRuntime()
    channels.store.bind('telegram', '-100', { projectId: 'p1', role: 'owner', userId: '7' })
    const response = await postWebhook(channels, {
      update_id: 11,
      message: {
        message_id: 11,
        text: `/approve ap1 ${'a'.repeat(64)} 11111111-2222-3333-4444-555555555555`,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 7 },
      },
    })
    expect(response.status).toBe(200)
    expect(fake.decided).toHaveLength(0)
  })

  it('dedupes one update_id across a restart of the runtime (file store)', async () => {
    const fake = fakeLedger()
    const storePath = tempStorePath()
    const env = { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv
    const update = {
      update_id: 21,
      message: {
        message_id: 21,
        text: `/approve ap1 ${'a'.repeat(64)} 11111111-2222-3333-4444-555555555555`,
        chat: { id: 5, type: 'private' },
        from: { id: 7 },
      },
    }
    const first = startChannelsRuntime(fake.ledger, { env, storePath })
    expect(first).not.toBeNull()
    if (!first) return
    first.store.bind('telegram', '5', { projectId: 'p1', role: 'approver', userId: '7' })
    expect((await postWebhook(first, update)).status).toBe(200)
    expect(fake.decided).toHaveLength(1)

    // A fresh runtime on the same file (a process restart) must still see the claim.
    const second = startChannelsRuntime(fake.ledger, { env, storePath })
    expect(second).not.toBeNull()
    if (!second) return
    expect(JSON.parse((await postWebhook(second, update)).body)).toEqual({ ok: true, duplicate: true })
    expect(fake.decided).toHaveLength(1)
  })

  it('throttles repeated bad secrets with 429 and Retry-After', async () => {
    const { channels } = liveRuntime()
    const wrong = { [TELEGRAM_SECRET_HEADER]: 'wrong-secret-value' }
    for (let i = 0; i < 30; i += 1) {
      const response = await postWebhook(channels, UPDATE, wrong)
      expect(response.status).toBe(401)
    }
    const blocked = await postWebhook(channels, UPDATE, wrong)
    expect(blocked.status).toBe(429)
    expect(JSON.parse(blocked.body)).toEqual({ ok: false, error: 'too_many_requests' })
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    // A correct secret from the same peer is also paused: the throttle is on the peer, not the value.
    expect((await postWebhook(channels, UPDATE)).status).toBe(429)
  })
})
