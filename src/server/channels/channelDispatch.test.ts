import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelStore } from './channelStore'
import {
  dispatchTelegramUpdate,
  extractRejectChallenge,
  type ApprovalSummary,
  type ChannelApprovalPort,
  type ChannelReply,
} from './channelDispatch'

const DIGEST = 'a'.repeat(64)
const NONCE = '11111111-2222-3333-4444-555555555555'
const dirs: string[] = []

function tempStore(): ChannelStore {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-dispatch-'))
  dirs.push(root)
  return new ChannelStore(join(root, 'channels', 'channels.json'))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function update(updateId: number, chatId: number, userId: number, text: string, chatType = 'private') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: chatId, type: chatType },
      from: { id: userId },
    },
  }
}

interface FakeApproval {
  port: ChannelApprovalPort
  decide: ReturnType<typeof vi.fn>
  consume: ReturnType<typeof vi.fn>
  approvals: Map<string, ApprovalSummary>
}

function fakeApproval(seed: ApprovalSummary[] = []): FakeApproval {
  const approvals = new Map(seed.map((row) => [row.id, { ...row }]))
  const decide = vi.fn((id: string, input: { approve: boolean }) => {
    const row = approvals.get(id)
    if (!row) throw new Error(`approval not found: ${id}`)
    row.status = input.approve ? 'approved' : 'rejected'
    return row
  })
  const consume = vi.fn(() => true)
  return {
    decide,
    consume,
    approvals,
    port: {
      listApprovals: (opts) =>
        [...approvals.values()].filter(
          (row) => (opts?.projectId === undefined || row.projectId === opts.projectId) &&
            (opts?.status === undefined || row.status === opts.status)
        ),
      getApproval: (id) => approvals.get(id) ?? null,
      decideApproval: decide as unknown as ChannelApprovalPort['decideApproval'],
      consumeApproval: consume,
    },
  }
}

function boundStore(role: 'viewer' | 'approver' = 'approver'): ChannelStore {
  const store = tempStore()
  store.bind('telegram', '100', { projectId: 'p1', role, userId: '7' })
  return store
}

describe('telegram dispatch authorization', () => {
  it('denies a group chat even for an /approve from a bound chat id', async () => {
    const store = boundStore()
    store.bind('telegram', '-100', { projectId: 'p1', role: 'owner', userId: '7' })
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const outcome = await dispatchTelegramUpdate(
      update(1, -100, 7, `/approve ap1 ${DIGEST} ${NONCE}`, 'supergroup'),
      { store, approval: approval.port }
    )
    expect(outcome).toEqual({ status: 'denied', reason: 'group_not_allowed' })
    expect(approval.decide).not.toHaveBeenCalled()
  })

  it('denies an unknown chat silently and never auto-enrolls it', async () => {
    const store = tempStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const replies: ChannelReply[] = []
    const outcome = await dispatchTelegramUpdate(update(2, 999, 7, `/approve ap1 ${DIGEST} ${NONCE}`), {
      store,
      approval: approval.port,
      enqueue: (reply) => {
        replies.push(reply)
      },
    })
    expect(outcome).toEqual({ status: 'denied', reason: 'unknown_chat' })
    expect(approval.decide).not.toHaveBeenCalled()
    expect(replies).toHaveLength(0)
    expect(store.binding('telegram', '999')).toBeUndefined()
  })

  it('denies /approve for a viewer and for a mismatched user id', async () => {
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const viewer = boundStore('viewer')
    expect(
      await dispatchTelegramUpdate(update(3, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`), {
        store: viewer,
        approval: approval.port,
      })
    ).toEqual({ status: 'denied', reason: 'role_denied' })

    const approver = boundStore()
    expect(
      await dispatchTelegramUpdate(update(4, 100, 8, `/approve ap1 ${DIGEST} ${NONCE}`), {
        store: approver,
        approval: approval.port,
      })
    ).toEqual({ status: 'denied', reason: 'user_mismatch' })
    expect(approval.decide).not.toHaveBeenCalled()
  })
})

describe('telegram dispatch consent', () => {
  it('treats a bare "yes" as text: no decision, guidance reply only', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const outcome = await dispatchTelegramUpdate(update(5, 100, 7, 'yes'), {
      store,
      approval: approval.port,
    })
    expect(outcome.status).toBe('handled')
    if (outcome.status === 'handled') {
      expect(outcome.command).toBe('free_text')
      expect(outcome.reply).toContain('/approve')
    }
    expect(approval.decide).not.toHaveBeenCalled()
    expect(approval.consume).not.toHaveBeenCalled()
  })

  it('requires id + digest + nonce; a short /approve is usage, not consent', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const outcome = await dispatchTelegramUpdate(update(6, 100, 7, '/approve ap1'), {
      store,
      approval: approval.port,
    })
    expect(outcome.status).toBe('handled')
    expect(approval.decide).not.toHaveBeenCalled()
  })

  it('approves exactly once with the ledger challenge and does not consume it by default', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const outcome = await dispatchTelegramUpdate(update(7, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`), {
      store,
      approval: approval.port,
    })
    expect(outcome.status).toBe('handled')
    expect(approval.decide).toHaveBeenCalledTimes(1)
    expect(approval.decide).toHaveBeenCalledWith('ap1', {
      actor: 'telegram:7',
      approve: true,
      digest: DIGEST,
      nonce: NONCE,
    })
    expect(approval.consume).not.toHaveBeenCalled()
    expect(approval.approvals.get('ap1')?.status).toBe('approved')
  })

  it('consumes after decide only when the channel is the executor', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    await dispatchTelegramUpdate(update(8, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`), {
      store,
      approval: approval.port,
      consumeOnApprove: true,
    })
    expect(approval.decide).toHaveBeenCalledTimes(1)
    expect(approval.consume).toHaveBeenCalledWith('ap1', { digest: DIGEST })
  })

  it('refuses an approval from another project and a non-pending approval', async () => {
    const store = boundStore()
    const other = fakeApproval([{ id: 'ap9', projectId: 'p2', status: 'pending' }])
    const crossProject = await dispatchTelegramUpdate(update(9, 100, 7, `/approve ap9 ${DIGEST} ${NONCE}`), {
      store,
      approval: other.port,
    })
    expect(crossProject.status).toBe('handled')
    expect(other.decide).not.toHaveBeenCalled()

    const spent = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'rejected' }])
    await dispatchTelegramUpdate(update(10, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`), {
      store,
      approval: spent.port,
    })
    expect(spent.decide).not.toHaveBeenCalled()
  })

  it('rejects without a digest+nonce pair and with one', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    await dispatchTelegramUpdate(update(11, 100, 7, '/reject ap1 too risky'), {
      store,
      approval: approval.port,
    })
    expect(approval.decide).not.toHaveBeenCalled()

    await dispatchTelegramUpdate(update(12, 100, 7, `/reject ap1 ${DIGEST} ${NONCE} too risky`), {
      store,
      approval: approval.port,
    })
    expect(approval.decide).toHaveBeenCalledWith('ap1', {
      actor: 'telegram:7',
      approve: false,
      digest: DIGEST,
      nonce: NONCE,
    })
  })
})

describe('telegram dispatch idempotency and scrubbing', () => {
  it('100 replays of one update produce one decision and one queued reply', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const enqueued: string[] = []
    const deps = {
      store,
      approval: approval.port,
      enqueue: (reply: ChannelReply) => {
        enqueued.push(reply.dedupeKey)
      },
    }
    const payload = update(13, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`)
    for (let i = 0; i < 100; i += 1) await dispatchTelegramUpdate(payload, deps)
    expect(approval.decide).toHaveBeenCalledTimes(1)
    expect(enqueued).toHaveLength(1)
    // A store-backed outbox (the production path) also dedupes by key.
    const second = fakeApproval([{ id: 'ap2', projectId: 'p1', status: 'pending' }])
    const secondPayload = update(14, 100, 7, `/approve ap2 ${DIGEST} ${NONCE}`)
    for (let i = 0; i < 100; i += 1) {
      await dispatchTelegramUpdate(secondPayload, { store, approval: second.port })
    }
    expect(second.decide).toHaveBeenCalledTimes(1)
    expect(store.pendingReplies()).toHaveLength(1)
  })

  it('keeps a provider secret out of the reply when the ledger throws', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    approval.decide.mockImplementation(() => {
      throw new Error('upstream failed for https://api.telegram.org/bot123456:SECRET-TOKEN-VALUE/sendMessage')
    })
    const outcome = await dispatchTelegramUpdate(update(15, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`), {
      store,
      approval: approval.port,
    })
    expect(outcome.status).toBe('handled')
    if (outcome.status === 'handled') {
      expect(outcome.reply).not.toContain('SECRET-TOKEN-VALUE')
      expect(outcome.reply).toContain('[redacted]')
    }
  })

  it('handles 25 concurrent deliveries of one update with a single effect', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const payload = update(16, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`)
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => dispatchTelegramUpdate(payload, { store, approval: approval.port }))
    )
    expect(approval.decide).toHaveBeenCalledTimes(1)
    expect(outcomes.filter((row) => row.status === 'duplicate')).toHaveLength(24)
  })

  it('keeps an already-applied decision when the outbox fails, and does not re-run it', async () => {
    const store = boundStore()
    const approval = fakeApproval([{ id: 'ap1', projectId: 'p1', status: 'pending' }])
    const payload = update(17, 100, 7, `/approve ap1 ${DIGEST} ${NONCE}`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = {
      store,
      approval: approval.port,
      enqueue: (): void => {
        throw new Error('outbox unavailable for https://api.telegram.org/bot123456:SECRET-TOKEN-VALUE/sendMessage')
      },
    }
    // The ledger decision is the effect; a dead outbox is reported by a missing reply, never by
    // undoing the claim (a release would let the provider retry re-apply the command).
    const first = await dispatchTelegramUpdate(payload, deps)
    expect(first).toMatchObject({ status: 'handled', reply: null })
    expect(approval.decide).toHaveBeenCalledTimes(1)
    const retried = await dispatchTelegramUpdate(payload, deps)
    expect(retried.status).toBe('duplicate')
    expect(approval.decide).toHaveBeenCalledTimes(1)
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('reply enqueue failed')
    expect(logged).not.toContain('SECRET-TOKEN-VALUE')
    warn.mockRestore()
  })

  it('extracts a challenge only from a 64-hex digest plus nonce prefix', () => {
    expect(extractRejectChallenge(`${DIGEST} ${NONCE} because`)).toEqual({
      digest: DIGEST,
      nonce: NONCE,
      reason: 'because',
    })
    expect(extractRejectChallenge('because')).toBeNull()
    expect(extractRejectChallenge(`abc ${NONCE}`)).toBeNull()
  })

  it('routes bound free text to central chat and preserves idempotency', async () => {
    const store = boundStore('viewer')
    const ask = vi.fn(async (input: { projectId: string; text: string; updateId: number }) => {
      expect(input).toEqual({ projectId: 'p1', text: 'hello central', updateId: 18 })
      return { ok: true as const, text: 'assistant answer' }
    })
    const replies: ChannelReply[] = []
    const deps = { store, centralChat: { ask }, enqueue: (reply: ChannelReply): void => { replies.push(reply) } }
    const first = await dispatchTelegramUpdate(update(18, 100, 7, 'hello central'), deps)
    const second = await dispatchTelegramUpdate(update(18, 100, 7, 'hello central'), deps)
    expect(first).toMatchObject({ status: 'handled', command: 'free_text', reply: 'assistant answer' })
    expect(second.status).toBe('duplicate')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(replies[0]?.text).toBe('assistant answer')
  })
})
