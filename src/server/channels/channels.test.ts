import { describe, expect, it } from 'vitest'

import {
  IdentityRegistry,
  authorizeCommand,
  isBareConsent,
  parseCommand,
  type ChannelCommand,
  type ChannelMessageIdentity,
  type ChannelRole,
} from './identity'
import { parseTelegramUpdate } from './telegram'

const msg = (chatId: string, userId: string, isGroup = false): ChannelMessageIdentity => ({
  channel: 'telegram',
  chatId,
  userId,
  isGroup,
})

describe('telegram update normalization', () => {
  const groupUpdate = {
    update_id: 42,
    message: {
      message_id: 7,
      message_thread_id: 3,
      text: '/status',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 555 },
    },
  }

  it('normalizes a group message', () => {
    expect(parseTelegramUpdate(groupUpdate)).toEqual({
      updateId: 42,
      chatId: '-100123',
      userId: '555',
      text: '/status',
      isGroup: true,
      messageId: 7,
      threadId: 3,
    })
  })

  it('treats a private chat as a non-group and defaults text to empty', () => {
    const normalized = parseTelegramUpdate({
      update_id: 1,
      message: { chat: { id: 9, type: 'private' }, from: { id: 9 }, photo: [] },
    })
    expect(normalized).toMatchObject({ chatId: '9', userId: '9', text: '', isGroup: false })
  })

  it('returns null for updates without a usable message', () => {
    expect(parseTelegramUpdate({ message: groupUpdate.message })).toBeNull()
    expect(parseTelegramUpdate({ update_id: 5, callback_query: { id: 'x' } })).toBeNull()
    expect(parseTelegramUpdate({ update_id: -1 })).toBeNull()
  })
})

describe('identity and authorization', () => {
  const registry = new IdentityRegistry()
  registry.bind('telegram', '100', { projectId: 'p1', role: 'approver', userId: '7' })
  registry.bind('telegram', '-100', { projectId: 'p1', role: 'viewer' })
  const approve: ChannelCommand = { kind: 'approve', approvalId: 'a', digest: 'd', nonce: 'n' }

  it('rejects an unknown chat instead of auto-enrolling', () => {
    expect(authorizeCommand(msg('999', '7'), approve, registry)).toEqual({ ok: false, reason: 'unknown_chat' })
  })

  it('denies approval from a bound group even with an approver binding', () => {
    registry.bind('telegram', '-200', { projectId: 'p1', role: 'owner', userId: '7' })
    expect(authorizeCommand(msg('-200', '7', true), approve, registry)).toEqual({ ok: false, reason: 'group_not_allowed' })
  })

  it('allows a bound approver to approve in a private chat only', () => {
    const expected = { ok: true, binding: { projectId: 'p1', role: 'approver', userId: '7' } }
    expect(authorizeCommand(msg('100', '7'), approve, registry)).toEqual(expected)
    expect(registry.unbind('telegram', '100')).toBe(true)
    expect(registry.resolve('telegram', '100')).toBeUndefined()
    registry.bind('telegram', '100', { projectId: 'p1', role: 'approver', userId: '7' })
  })

  it('denies a different user, a non-approver role, and lets groups read status', () => {
    expect(authorizeCommand(msg('100', '8'), approve, registry)).toEqual({ ok: false, reason: 'user_mismatch' })
    registry.bind('telegram', '300', { projectId: 'p1', role: 'viewer', userId: '7' })
    expect(authorizeCommand(msg('300', '7'), approve, registry)).toEqual({ ok: false, reason: 'role_denied' })
    expect(authorizeCommand(msg('-100', '5', true), { kind: 'status' }, registry).ok).toBe(true)
  })

  it('rejects invalid bindings', () => {
    expect(() => registry.bind('telegram', 'x', { projectId: 'p', role: 'root' as ChannelRole })).toThrow()
  })
})

describe('command grammar', () => {
  it('parses the deterministic command set', () => {
    expect(parseCommand('/status')).toEqual({ ok: true, command: { kind: 'status' } })
    expect(parseCommand('/status@WebtermBot proj')).toEqual({ ok: true, command: { kind: 'status', project: 'proj' } })
    expect(parseCommand('/inbox')).toEqual({ ok: true, command: { kind: 'inbox' } })
    expect(parseCommand('/task t-1')).toEqual({ ok: true, command: { kind: 'task', taskId: 't-1' } })
    expect(parseCommand('/approve a1 sha256abc nonce1')).toEqual({
      ok: true,
      command: { kind: 'approve', approvalId: 'a1', digest: 'sha256abc', nonce: 'nonce1' },
    })
    expect(parseCommand('/reject a1 wrong target')).toEqual({
      ok: true,
      command: { kind: 'reject', approvalId: 'a1', reason: 'wrong target' },
    })
    expect(parseCommand('/pause')).toEqual({ ok: true, command: { kind: 'pause' } })
    expect(parseCommand('/resume p1')).toEqual({ ok: true, command: { kind: 'resume', project: 'p1' } })
  })

  it('never treats free text or bare "yes" as consent', () => {
    expect(parseCommand('yes')).toMatchObject({ ok: false, code: 'not_a_command' })
    expect(parseCommand('ok!')).toMatchObject({ ok: false, code: 'not_a_command' })
    expect(parseCommand('deploy it')).toMatchObject({ ok: false, code: 'not_a_command' })
    expect(isBareConsent('Yes')).toBe(true)
    expect(isBareConsent('/approve a b c')).toBe(false)
  })

  it('returns usage errors for malformed or unknown commands', () => {
    expect(parseCommand('')).toMatchObject({ ok: false, code: 'empty' })
    expect(parseCommand('/approve a1 digest')).toMatchObject({ ok: false, code: 'usage' })
    expect(parseCommand('/status a b')).toMatchObject({ ok: false, code: 'usage' })
    expect(parseCommand('/exec rm -rf /')).toMatchObject({ ok: false, code: 'unknown_command' })
    expect(parseCommand(`/${'x'.repeat(513)}`)).toMatchObject({ ok: false, code: 'too_long' })
  })
})
