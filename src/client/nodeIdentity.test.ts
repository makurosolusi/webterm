import { describe, expect, it, vi } from 'vitest'
import {
  autoTitleFromWork, idleAgentIds, isAutoName,
  stopAgent, stopIdleAgents, uniqueTitle,
} from './nodeIdentity'
import type { AgentStatus } from '../shared/workspace'

describe('auto names', () => {
  it('a legacy generated <adjective>-<noun> title (with or without a tier suffix) or none counts as auto', () => {
    expect(isAutoName('brisk-otter')).toBe(true)
    expect(isAutoName('brisk-otter-3')).toBe(true)
    expect(isAutoName(undefined)).toBe(true)
    expect(isAutoName('Fix login bug')).toBe(false)
    expect(isAutoName('my-worker')).toBe(false)
  })

  it('uniqueTitle suffixes duplicates case-insensitively', () => {
    expect(uniqueTitle('Fix bug', [])).toBe('Fix bug')
    expect(uniqueTitle('Fix bug', ['fix bug'])).toBe('Fix bug (2)')
    expect(uniqueTitle('Fix bug', ['Fix bug', 'Fix bug (2)'])).toBe('Fix bug (3)')
  })
})

describe('autoTitleFromWork', () => {
  const setup = (title: string | undefined, others: string[] = []) => {
    const state = { title }
    const deps = {
      getTitle: () => state.title,
      boardTitles: () => others,
      setTitle: vi.fn((t: string) => { state.title = t }),
      generate: vi.fn(async () => ({ ok: true, message: 'Fix Login Bug' })),
    }
    return { state, deps }
  }

  it('renames a generated name from the first task', async () => {
    const { state, deps } = setup('brisk-otter')
    expect(await autoTitleFromWork('n1', deps)).toBe(true)
    expect(state.title).toBe('Fix Login Bug')
  })

  it('dedupes the derived title against the board', async () => {
    const { state, deps } = setup('brisk-otter', ['Fix Login Bug'])
    await autoTitleFromWork('n1', deps)
    expect(state.title).toBe('Fix Login Bug (2)')
  })

  it('never overwrites a manual rename', async () => {
    const { state, deps } = setup('My deploy box')
    expect(await autoTitleFromWork('n1', deps)).toBe(false)
    expect(deps.generate).not.toHaveBeenCalled()
    expect(state.title).toBe('My deploy box')
  })

  it('drops the result when the user renames during generation', async () => {
    const { state, deps } = setup('brisk-otter')
    deps.generate.mockImplementation(async () => { state.title = 'Mine'; return { ok: true, message: 'Fix Login Bug' } })
    expect(await autoTitleFromWork('n1', deps)).toBe(false)
    expect(state.title).toBe('Mine')
  })

  it('keeps the generated name when naming fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { state, deps } = setup('brisk-otter')
    deps.generate.mockResolvedValue({ ok: false, message: 'No terminal output to read yet.' })
    expect(await autoTitleFromWork('n1', deps)).toBe(false)
    deps.generate.mockRejectedValue(new Error('offline'))
    expect(await autoTitleFromWork('n1', deps)).toBe(false)
    expect(state.title).toBe('brisk-otter')
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('stop actions', () => {
  const nodes = [
    { id: 'a', type: 'agent' }, { id: 'b', type: 'agent' }, { id: 'c', type: 'agent' },
    { id: 'd', type: 'agent' }, { id: 'e', type: 'agent' }, { id: 't', type: 'terminal' },
  ]
  const status: Record<string, AgentStatus | undefined> = { a: 'waiting', b: 'done', c: 'working', d: 'blocked', t: 'done' }
  const statusOf = (id: string) => status[id]

  it('idle = turn ended or finished agent nodes only', () => {
    expect(idleAgentIds(nodes, statusOf)).toEqual(['a', 'b'])
  })

  it('stopAgent sends the existing close message only after confirm', () => {
    const send = vi.fn()
    expect(stopAgent('a', 'brisk-otter', send, () => false)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    const confirm = vi.fn((_q: string) => true)
    expect(stopAgent('a', 'brisk-otter', send, confirm)).toBe(true)
    expect(confirm.mock.calls[0][0]).toContain('brisk-otter')
    expect(send).toHaveBeenCalledWith({ t: 'close', id: 'a' })
  })

  it('stopIdleAgents closes every idle agent after one confirm, and tells when there is none', () => {
    const send = vi.fn()
    expect(stopIdleAgents(nodes, statusOf, send, () => false)).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(stopIdleAgents(nodes, statusOf, send, () => true)).toBe(2)
    expect(send.mock.calls).toEqual([[{ t: 'close', id: 'a' }], [{ t: 'close', id: 'b' }]])
    const notify = vi.fn()
    expect(stopIdleAgents(nodes, () => 'working', send, () => true, notify)).toBe(0)
    expect(notify).toHaveBeenCalledWith('No idle or finished agents on this board.')
  })
})
