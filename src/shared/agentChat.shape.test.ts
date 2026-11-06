import { describe, expect, it } from 'vitest'
import { validAgentChatData } from './agentChat.shape'

describe('validAgentChatData', () => {
  it('keeps every well-typed field', () => {
    const good = { agentId: 'claude', claudeProfileId: 'p1', chatSessionId: 's1', permissionMode: 'acceptEdits' }
    expect(validAgentChatData(good)).toEqual(good)
  })

  it('accepts the creation shape (no session yet, no mode)', () => {
    expect(validAgentChatData({ agentId: 'claude' })).toEqual({ agentId: 'claude' })
  })

  it('rejects anything that is not a Claude chat', () => {
    expect(validAgentChatData(undefined)).toBeUndefined()
    expect(validAgentChatData('claude')).toBeUndefined()
    expect(validAgentChatData({})).toBeUndefined()
    expect(validAgentChatData({ agentId: 'codex', chatSessionId: 's1' })).toBeUndefined()
  })

  it('drops mistyped or unknown fields instead of persisting them', () => {
    const out = validAgentChatData({ agentId: 'claude', claudeProfileId: 7, chatSessionId: '', permissionMode: 'yolo', extra: 'x' })
    expect(out).toEqual({ agentId: 'claude' })
  })
})
