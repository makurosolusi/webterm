/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_PATH,
  INBOX_PATH,
  InboxApiError,
  consumeApproval,
  decideApproval,
  inboxErrorMessage,
  isAbortError,
  listApproved,
  listInbox,
  requestApproval,
  type ApprovedApproval,
  type InboxItem,
} from './inboxApi'

const TOKEN_KEY = 'webterm.token'
const TOKEN = 'tkn-do-not-print'

const item: InboxItem = {
  id: 'inbox-1',
  kind: 'deploy',
  state: 'needs_you',
  projectId: 'proj-a',
  title: 'Deploy main',
  ageMs: 125_000,
  detail: 'Push to production',
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

function headersOf(call: number): Record<string, string> {
  const init = fetchMock.mock.calls[call][1] as RequestInit
  return init.headers as Record<string, string>
}

function initOf(call: number): RequestInit {
  return fetchMock.mock.calls[call][1] as RequestInit
}

beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('listInbox', () => {
  it('GETs /api/inbox with the session token header and parses { items }', async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN)
    fetchMock.mockResolvedValue(response({ items: [item] }))

    await expect(listInbox()).resolves.toEqual([item])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(INBOX_PATH)
    expect(initOf(0).method).toBe('GET')
    expect(headersOf(0)['x-webterm-token']).toBe(TOKEN)
    expect(headersOf(0).Accept).toBe('application/json')
  })

  it('accepts a bare array and sends no token header when none is configured', async () => {
    fetchMock.mockResolvedValue(response([item]))

    await expect(listInbox()).resolves.toEqual([item])
    expect(headersOf(0)).not.toHaveProperty('x-webterm-token')
  })

  it('prefers a one-time ?token= from the URL over sessionStorage', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'stale')
    window.history.replaceState(null, '', '/?token=url-token')
    fetchMock.mockResolvedValue(response({ items: [] }))

    await listInbox()
    expect(headersOf(0)['x-webterm-token']).toBe('url-token')
  })

  it('never puts the token in the request URL', async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN)
    fetchMock.mockResolvedValue(response({ items: [] }))

    await listInbox()
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(TOKEN)
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('token=')
  })

  it('drops malformed rows instead of hiding the valid ones', async () => {
    fetchMock.mockResolvedValue(
      response({
        items: [
          item,
          { id: 'x' },
          { ...item, id: 'bad-state', state: 'later' },
          { ...item, id: 'bad-age', ageMs: Number.NaN },
        ],
      })
    )

    const rows = await listInbox()
    expect(rows.map((row) => row.id)).toEqual(['inbox-1', 'bad-age'])
    expect(rows[1]?.ageMs).toBe(0)
  })

  it('preserves a positive integer fence on a task row', async () => {
    fetchMock.mockResolvedValue(
      response({
        items: [{ ...item, id: 't-1', kind: 'task', fence: 7 }],
      })
    )

    const [row] = await listInbox()
    expect(row).toEqual({ ...item, id: 't-1', kind: 'task', fence: 7 })
  })

  it('omits a fence that is not a positive integer', async () => {
    fetchMock.mockResolvedValue(
      response({
        items: [
          { ...item, id: 'str', fence: '7' },
          { ...item, id: 'neg', fence: -1 },
          { ...item, id: 'zero', fence: 0 },
          { ...item, id: 'frac', fence: 1.5 },
          { ...item, id: 'nan', fence: Number.NaN },
          { ...item, id: 'null', fence: null },
        ],
      })
    )

    const rows = await listInbox()
    expect(rows.map((row) => row.id)).toEqual(['str', 'neg', 'zero', 'frac', 'nan', 'null'])
    for (const row of rows) expect(row).not.toHaveProperty('fence')
  })

  it('throws a typed error carrying the server code and status', async () => {
    fetchMock.mockResolvedValue(response({ error: 'forbidden' }, 403))

    const error = await listInbox().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboxApiError)
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
    expect(inboxErrorMessage(error)).toMatch(/refused by the server/i)
  })

  it('falls back to http_<status> when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response)

    const error = await listInbox().catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, code: 'http_502' })
  })

  it('rejects a response without an item list', async () => {
    fetchMock.mockResolvedValue(response({ nope: true }))
    const error = await listInbox().catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, code: 'bad_response' })
  })

  it('passes the abort signal and surfaces an abort as AbortError', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )

    const error = await listInbox({ signal: controller.signal }).catch((e: unknown) => e)
    expect(isAbortError(error)).toBe(true)
    expect(initOf(0).signal).toBe(controller.signal)
  })
})

describe('approval calls', () => {
  const challenge = {
    id: 'ap-1',
    digest: 'a'.repeat(64),
    nonce: 'n-1',
    expiresAt: 1_700_000_900_000,
    kind: 'deploy',
    projectId: 'proj-a',
  }

  it('requests a challenge with the exact action payload', async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN)
    fetchMock.mockResolvedValue(response(challenge))

    await expect(
      requestApproval({ kind: 'deploy', projectId: 'proj-a', request: { branch: 'main' } })
    ).resolves.toEqual(challenge)

    expect(fetchMock.mock.calls[0][0]).toBe(`${APPROVAL_PATH}/request`)
    expect(initOf(0).method).toBe('POST')
    expect(headersOf(0)['Content-Type']).toBe('application/json')
    expect(headersOf(0)['x-webterm-token']).toBe(TOKEN)
    const sent = JSON.parse(String(initOf(0).body)) as Record<string, unknown>
    expect(sent).toMatchObject({ kind: 'deploy', projectId: 'proj-a', request: { branch: 'main' } })
    expect(String(sent.requestId)).toMatch(/^[A-Za-z0-9_-]{8,128}$/)
  })

  it('uses a caller-supplied requestId for idempotent retries', async () => {
    fetchMock.mockResolvedValue(response(challenge))
    await requestApproval({ kind: 'deploy', projectId: 'p', request: {}, requestId: 'fixed-request-id' })
    expect(JSON.parse(String(initOf(0).body))).toMatchObject({ requestId: 'fixed-request-id' })
  })

  it('accepts a challenge without kind/projectId by echoing the request values', async () => {
    fetchMock.mockResolvedValue(
      response({ id: 'ap-1', digest: 'd', nonce: 'n', expiresAt: 123 })
    )
    await expect(requestApproval({ kind: 'deploy', projectId: 'proj-a', request: {} })).resolves.toEqual({
      id: 'ap-1',
      digest: 'd',
      nonce: 'n',
      expiresAt: 123,
      kind: 'deploy',
      projectId: 'proj-a',
    })
  })

  it('sends the task identity and fence verbatim for a task review', async () => {
    fetchMock.mockResolvedValue(response({ ...challenge, kind: 'task', projectId: 'proj-a' }))

    await requestApproval({
      kind: 'task',
      projectId: 'proj-a',
      request: { itemId: 't-1', taskId: 't-1', fence: 7, title: 'Review task', detail: null },
    })

    expect(JSON.parse(String(initOf(0).body))).toMatchObject({
      kind: 'task',
      projectId: 'proj-a',
      request: { itemId: 't-1', taskId: 't-1', fence: 7, title: 'Review task', detail: null },
    })
  })

  it('accepts the server inbox projection shape (category/evidenceSummary)', async () => {
    fetchMock.mockResolvedValue(
      response({
        items: [
          {
            id: 'task-1',
            category: 'broken',
            kind: 'lease',
            projectId: null,
            projectName: null,
            title: 'stale lease',
            ageMs: 12,
            createdAt: 1,
            status: 'leased',
            evidenceSummary: 'lease expired',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      })
    )
    await expect(listInbox()).resolves.toEqual([
      { id: 'task-1', kind: 'lease', state: 'broken', projectId: '', title: 'stale lease', ageMs: 12, detail: 'lease expired' },
    ])
  })

  it('rejects an incomplete challenge rather than approving with missing consent fields', async () => {
    fetchMock.mockResolvedValue(response({ id: 'ap-1', digest: 'd', kind: 'deploy', projectId: 'p' }))
    const error = await requestApproval({ kind: 'deploy', projectId: 'p', request: {} }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, code: 'bad_response' })
  })

  it('validates input before touching the network', async () => {
    const error = await requestApproval({ kind: '  ', projectId: 'p', request: {} }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('decides with the digest and nonce returned by the server, verbatim', async () => {
    fetchMock.mockResolvedValue(response({ id: 'ap-1', status: 'approved', digest: challenge.digest }))

    await expect(
      decideApproval({ id: 'ap-1', digest: challenge.digest, nonce: challenge.nonce, approve: true, actor: 'me' })
    ).resolves.toMatchObject({ id: 'ap-1', status: 'approved' })

    expect(fetchMock.mock.calls[0][0]).toBe(`${APPROVAL_PATH}/decide`)
    expect(JSON.parse(String(initOf(0).body))).toMatchObject({
      id: 'ap-1',
      digest: challenge.digest,
      nonce: challenge.nonce,
      approve: true,
      actor: 'me',
    })
    expect(JSON.parse(String(initOf(0).body))).toHaveProperty('requestId')
  })

  it('surfaces a digest mismatch as a typed, human message', async () => {
    fetchMock.mockResolvedValue(response({ error: 'digest_mismatch' }, 409))
    const error = await decideApproval({
      id: 'ap-1',
      digest: challenge.digest,
      nonce: challenge.nonce,
      approve: true,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 409, code: 'digest_mismatch' })
    expect(inboxErrorMessage(error)).toMatch(/action changed/i)
  })

  it('consumes with id + digest and refuses a non-ok body', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true, id: 'ap-1' }))
    await expect(consumeApproval({ id: 'ap-1', digest: challenge.digest })).resolves.toEqual({
      ok: true,
      id: 'ap-1',
    })
    expect(fetchMock.mock.calls[0][0]).toBe(`${APPROVAL_PATH}/consume`)

    fetchMock.mockResolvedValueOnce(response({ ok: false }))
    const error = await consumeApproval({ id: 'ap-1', digest: challenge.digest }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 409, code: 'not_consumed' })
  })
})

describe('listApproved', () => {
  const approved: ApprovedApproval = {
    id: 'ap-approved',
    projectId: 'proj-a',
    kind: 'task',
    taskId: 'task-1',
    fence: 7,
    digest: 'b'.repeat(64),
    expiresAt: 1_700_000_900_000,
  }

  it('GETs the approved, unconsumed page with the token header', async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN)
    fetchMock.mockResolvedValue(response({ items: [approved], total: 1, limit: 50, offset: 0 }))

    await expect(listApproved()).resolves.toEqual([approved])
    expect(fetchMock.mock.calls[0][0]).toBe(`${APPROVAL_PATH}?status=approved&limit=50`)
    expect(initOf(0).method).toBe('GET')
    expect(headersOf(0)['x-webterm-token']).toBe(TOKEN)
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(TOKEN)
  })

  it('accepts a bare array and rows without a task link', async () => {
    fetchMock.mockResolvedValue(
      response([
        { ...approved, taskId: undefined, fence: undefined },
        { ...approved, id: 'ap-2', taskId: '', fence: 0 },
      ])
    )

    const rows = await listApproved()
    expect(rows.map((row) => row.id)).toEqual(['ap-approved', 'ap-2'])
    for (const row of rows) {
      expect(row).not.toHaveProperty('taskId')
      expect(row).not.toHaveProperty('fence')
    }
  })

  it('drops rows that cannot be consumed instead of hiding the valid ones', async () => {
    fetchMock.mockResolvedValue(
      response({
        items: [
          approved,
          { ...approved, id: 'no-digest', digest: '' },
          { ...approved, id: 'no-project', projectId: undefined },
          { ...approved, id: 'no-kind', kind: 3 },
          { ...approved, id: 'no-expiry', expiresAt: null },
          { ...approved, id: 'fractional-fence', fence: 1.5 },
          'not-an-object',
        ],
      })
    )

    const rows = await listApproved()
    expect(rows.map((row) => row.id)).toEqual(['ap-approved', 'fractional-fence'])
    expect(rows[1]).not.toHaveProperty('fence')
  })

  it('throws bad_response when the body is not a list', async () => {
    fetchMock.mockResolvedValue(response({ nope: true }))
    const error = await listApproved().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboxApiError)
    expect(error).toMatchObject({ status: 502, code: 'bad_response' })
  })

  it('passes the abort signal and surfaces an abort as AbortError', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )

    const error = await listApproved({ signal: controller.signal }).catch((e: unknown) => e)
    expect(isAbortError(error)).toBe(true)
    expect(initOf(0).signal).toBe(controller.signal)
  })
})

describe('secret hygiene', () => {
  it('logs nothing on success or failure, and keeps the token out of messages', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    sessionStorage.setItem(TOKEN_KEY, TOKEN)
    fetchMock.mockResolvedValueOnce(response({ items: [] }))
    await listInbox()

    fetchMock.mockResolvedValueOnce(response({ error: 'forbidden' }, 403))
    const error = await listInbox().catch((e: unknown) => e)

    fetchMock.mockResolvedValueOnce(
      response({ items: [{ id: 'ap-1', projectId: 'p', kind: 'task', digest: 'd', expiresAt: 1 }] })
    )
    await listApproved()

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(String((error as Error).message)).not.toContain(TOKEN)
    expect(inboxErrorMessage(error)).not.toContain(TOKEN)
  })
})
