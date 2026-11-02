import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ChannelStore } from './channelStore'
import {
  channelBindingsRoute,
  createTelegramBinding,
  deleteTelegramBinding,
  listTelegramBindings,
  type BindingAuditEvent,
  type BindingStorePort,
  type RouteResult,
  type TelegramBindingView,
} from './channelBindingsApi'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store(): ChannelStore {
  const root = mkdtempSync(join(tmpdir(), 'webterm-bindings-'))
  dirs.push(root)
  return new ChannelStore(join(root, 'channels', 'channels.json'))
}

function items(result: RouteResult): TelegramBindingView[] {
  return (result.body as { items: TelegramBindingView[] }).items
}

async function call(
  method: string,
  params: Record<string, string> = {},
  body: unknown = undefined,
  target: BindingStorePort = store(),
  audit?: (event: BindingAuditEvent) => void
): Promise<RouteResult | null> {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return channelBindingsRoute(
    '/api/channels/telegram/bindings',
    method,
    new URLSearchParams(params),
    async () => raw,
    target,
    audit
  )
}

describe('binding API CRUD', () => {
  it('starts empty and never auto-enrolls a chat', () => {
    const result = listTelegramBindings(store())
    expect(result.status).toBe(200)
    expect(items(result)).toEqual([])
  })

  it('creates, lists, updates, and deletes a private-chat binding', async () => {
    const bindings = store()
    const created = await call(
      'POST',
      {},
      { projectId: 'p1', chatId: '42', role: 'approver', userId: '7' },
      bindings
    )
    expect(created?.status).toBe(201)
    expect((created?.body as { binding: TelegramBindingView }).binding).toEqual({
      channel: 'telegram',
      chatId: '42',
      projectId: 'p1',
      role: 'approver',
      userId: '7',
    })

    const listed = await call('GET', {}, undefined, bindings)
    expect(listed?.status).toBe(200)
    expect(items(listed as RouteResult)).toEqual([
      { channel: 'telegram', chatId: '42', projectId: 'p1', role: 'approver', userId: '7' },
    ])

    const updated = await call('POST', {}, { projectId: 'p2', chatId: '42', role: 'operator' }, bindings)
    expect(updated?.status).toBe(200)
    expect((updated?.body as { created: boolean }).created).toBe(false)
    expect(items(listed as RouteResult)[0]?.projectId).toBe('p1')
    expect(bindings.binding('telegram', '42')).toEqual({ projectId: 'p2', role: 'operator' })

    const removed = await call('DELETE', { chatId: '42' }, undefined, bindings)
    expect(removed).toEqual({ status: 200, body: { ok: true, chatId: '42' } })
    expect(bindings.binding('telegram', '42')).toBeUndefined()
    expect((await call('GET', {}, undefined, bindings))?.status).toBe(200)
    expect(items((await call('GET', {}, undefined, bindings)) as RouteResult)).toEqual([])
  })

  it('accepts a numeric chatId only when it is a safe integer', () => {
    expect(createTelegramBinding({ projectId: 'p', chatId: 42, role: 'viewer' }, store()).status).toBe(201)
    expect(createTelegramBinding({ projectId: 'p', chatId: 2 ** 60, role: 'viewer' }, store()).status).toBe(400)
  })
})

describe('group-chat role policy', () => {
  it('denies approval roles on a negative group chat id', () => {
    const bindings = store()
    for (const role of ['approver', 'owner']) {
      const result = createTelegramBinding({ projectId: 'p', chatId: '-100123', role }, bindings)
      expect(result.status).toBe(403)
      expect(result.body).toEqual({ error: 'group_approval_role_denied' })
    }
    expect(bindings.listBindings()).toEqual([])
  })

  it('allows viewer and operator in a group, and respects explicit isGroup', () => {
    const bindings = store()
    expect(createTelegramBinding({ projectId: 'p', chatId: '-100123', role: 'viewer' }, bindings).status).toBe(201)
    expect(createTelegramBinding({ projectId: 'p', chatId: '-100123', role: 'operator' }, bindings).status).toBe(200)
    expect(
      createTelegramBinding({ projectId: 'p', chatId: '999', role: 'owner', isGroup: true }, bindings).status
    ).toBe(403)
  })
})

describe('binding API validation', () => {
  const bindings = () => store()

  it('rejects malformed input without writing', () => {
    const target = bindings()
    const cases: Array<[unknown, string]> = [
      [[], 'invalid_body'],
      [{ chatId: '42', role: 'viewer' }, 'invalid_project_id'],
      [{ projectId: '   ', chatId: '42', role: 'viewer' }, 'invalid_project_id'],
      [{ projectId: 'x'.repeat(201), chatId: '42', role: 'viewer' }, 'invalid_project_id'],
      [{ projectId: 'p', chatId: 'abc', role: 'viewer' }, 'invalid_chat_id'],
      [{ projectId: 'p', role: 'viewer' }, 'invalid_chat_id'],
      [{ projectId: 'p', chatId: '42', role: 'root' }, 'invalid_role'],
      [{ projectId: 'p', chatId: '42', role: 'viewer', userId: 'nope' }, 'invalid_user_id'],
      [{ projectId: 'p\nq', chatId: '42', role: 'viewer' }, 'invalid_project_id'],
    ]
    for (const [body, error] of cases) {
      const result = createTelegramBinding(body, target)
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error })
    }
    expect(target.listBindings()).toEqual([])
  })

  it('rejects invalid JSON, oversized bodies, and unsupported paths/methods', async () => {
    const target = bindings()
    expect((await call('POST', {}, '{not json', target))?.status).toBe(400)
    expect((await call('POST', {}, 'x'.repeat(16 * 1024 + 1), target))?.status).toBe(413)
    expect(await call('PUT', {}, undefined, target)).toBeNull()
    expect(
      await channelBindingsRoute('/api/other', 'GET', new URLSearchParams(), async () => '', target)
    ).toBeNull()
  })

  it('returns 404 for an unknown binding and 400 for a bad delete id', () => {
    const target = bindings()
    expect(deleteTelegramBinding('42', target)).toEqual({ status: 404, body: { error: 'unknown_binding' } })
    expect(deleteTelegramBinding('bad', target).status).toBe(400)
    expect(deleteTelegramBinding(null, target).status).toBe(400)
  })

  it('returns 500 without leaking store errors', () => {
    const broken: BindingStorePort = {
      binding: () => {
        throw new Error('boom')
      },
      bind: () => {
        throw new Error('boom')
      },
      unbind: () => {
        throw new Error('boom')
      },
      listBindings: () => {
        throw new Error('boom')
      },
    }
    expect(listTelegramBindings(broken).status).toBe(500)
    expect(createTelegramBinding({ projectId: 'p', chatId: '1', role: 'viewer' }, broken).status).toBe(500)
    expect(deleteTelegramBinding('1', broken).status).toBe(500)
  })
})

describe('binding audit hook', () => {
  it('emits outcomes and survives a throwing observer', () => {
    const target = store()
    const events: BindingAuditEvent[] = []
    const audit = (event: BindingAuditEvent) => {
      events.push(event)
      throw new Error('observer down')
    }
    expect(createTelegramBinding({ projectId: 'p', chatId: '42', role: 'viewer' }, target, audit).status).toBe(201)
    expect(deleteTelegramBinding('42', target, audit).status).toBe(200)
    expect(createTelegramBinding({ projectId: 'p', chatId: '-1', role: 'owner' }, target, audit).status).toBe(403)
    expect(events.map((event) => [event.action, event.outcome])).toEqual([
      ['bind', 'ok'],
      ['unbind', 'ok'],
      ['bind', 'denied'],
    ])
    expect(JSON.stringify(events)).not.toContain('token')
  })
})
