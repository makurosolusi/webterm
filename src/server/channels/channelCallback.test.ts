import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { approvalCallbackData, parseApprovalCallback } from './channelCallback'
import { dispatchTelegramUpdate, type ApprovalSummary, type ChannelApprovalPort, type ChannelReply } from './channelDispatch'
import { ChannelStore } from './channelStore'
import type { ChannelRole } from './identity'

const DIGEST = 'a'.repeat(64)
const NONCE = '11111111-2222-3333-4444-555555555555'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(binding: { chatId: string; role: ChannelRole; userId?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-cb-'))
  dirs.push(root)
  const store = new ChannelStore(join(root, 'channels.json'))
  store.bind('telegram', binding.chatId, { projectId: 'p1', role: binding.role, ...(binding.userId ? { userId: binding.userId } : {}) })
  const row: ApprovalSummary = { id: 'ap-1', projectId: 'p1', status: 'pending' }
  const decide = vi.fn()
  const approval: ChannelApprovalPort = {
    listApprovals: () => [row],
    getApproval: () => row,
    decideApproval: decide,
    consumeApproval: () => true,
  }
  const replies: ChannelReply[] = []
  const answers: string[] = []
  const deps = {
    store,
    approval,
    challenge: { challengeFor: (id: string) => (id === 'ap-1' ? { digest: DIGEST, nonce: NONCE } : null) },
    enqueue: (r: ChannelReply): void => { replies.push(r) },
    answerCallback: async (_id: string, text: string): Promise<void> => { answers.push(text) },
  }
  return { deps, decide, replies, answers }
}

function press(updateId: number, chatId: number, userId: number, data: string, chatType = 'private') {
  return {
    update_id: updateId,
    callback_query: { id: `cb${updateId}`, from: { id: userId }, data, message: { message_id: 3, chat: { id: chatId, type: chatType } } },
  }
}

describe('approval callback data', () => {
  it('round-trips and stays within 64 bytes', () => {
    const data = approvalCallbackData('ap-1', true)
    expect(data).toBe('a:ap-1:y')
    expect(parseApprovalCallback(data!)).toEqual({ approvalId: 'ap-1', approve: true })
    expect(parseApprovalCallback('a:ap-1:n')?.approve).toBe(false)
    expect(approvalCallbackData('x'.repeat(80), true)).toBeNull()
    expect(parseApprovalCallback('b:ap-1:y')).toBeNull()
  })
})

describe('callback_query approvals', () => {
  it('approve button from a bound private approver calls decideApproval with the server-side challenge', async () => {
    const { deps, decide, replies, answers } = setup({ chatId: '100', role: 'approver', userId: '7' })
    const out = await dispatchTelegramUpdate(press(1, 100, 7, 'a:ap-1:y'), deps)
    expect(out).toMatchObject({ status: 'handled', command: 'approve' })
    expect(decide).toHaveBeenCalledWith('ap-1', { actor: 'telegram:7', approve: true, digest: DIGEST, nonce: NONCE })
    expect(replies[0]?.text).toContain('Approved ap-1')
    expect(answers).toHaveLength(1)
  })

  it('deny button decides approve=false', async () => {
    const { deps, decide } = setup({ chatId: '100', role: 'owner' })
    await dispatchTelegramUpdate(press(2, 100, 7, 'a:ap-1:n'), deps)
    expect(decide).toHaveBeenCalledWith('ap-1', expect.objectContaining({ approve: false, digest: DIGEST, nonce: NONCE }))
  })

  it('a group press is refused even when that chat id is bound with an approver role', async () => {
    const { deps, decide } = setup({ chatId: '-1001', role: 'approver' })
    const out = await dispatchTelegramUpdate(press(3, -1001, 7, 'a:ap-1:y', 'supergroup'), deps)
    expect(out).toEqual({ status: 'denied', reason: 'group_not_allowed' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('refuses unbound chats, wrong user, and non-approver roles', async () => {
    const unbound = setup({ chatId: '100', role: 'approver' })
    expect((await dispatchTelegramUpdate(press(4, 555, 7, 'a:ap-1:y'), unbound.deps)).status).toBe('denied')
    const wrongUser = setup({ chatId: '100', role: 'approver', userId: '7' })
    expect(await dispatchTelegramUpdate(press(5, 100, 8, 'a:ap-1:y'), wrongUser.deps)).toEqual({ status: 'denied', reason: 'user_mismatch' })
    const viewer = setup({ chatId: '100', role: 'viewer' })
    expect(await dispatchTelegramUpdate(press(6, 100, 7, 'a:ap-1:y'), viewer.deps)).toEqual({ status: 'denied', reason: 'role_denied' })
    for (const s of [unbound, wrongUser, viewer]) expect(s.decide).not.toHaveBeenCalled()
  })

  it('a replayed press decides once, and unknown or forged data never reaches the ledger', async () => {
    const { deps, decide } = setup({ chatId: '100', role: 'approver' })
    await dispatchTelegramUpdate(press(7, 100, 7, 'a:ap-1:y'), deps)
    expect((await dispatchTelegramUpdate(press(7, 100, 7, 'a:ap-1:y'), deps)).status).toBe('duplicate')
    await dispatchTelegramUpdate(press(8, 100, 7, 'a:ap-404:y'), deps)
    await dispatchTelegramUpdate(press(9, 100, 7, 'garbage'), deps)
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it('is ignored (old behavior) when no challenge port is wired', async () => {
    const { deps, decide } = setup({ chatId: '100', role: 'approver' })
    const { challenge: _unused, ...legacy } = deps
    expect(await dispatchTelegramUpdate(press(10, 100, 7, 'a:ap-1:y'), legacy)).toEqual({ status: 'ignored', reason: 'not_a_message' })
    expect(decide).not.toHaveBeenCalled()
  })
})
