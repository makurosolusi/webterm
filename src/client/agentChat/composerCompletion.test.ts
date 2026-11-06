import { describe, expect, it, vi } from 'vitest'
import type { AgentChatCommand } from '../../shared/agentChat.wire'
import {
  agentChatCompletion, applyCompletion, CATALOG_REUSE_MS, completionTriggerAt, FALLBACK_COMMANDS, rankCommands, rankFiles, withParentDirs,
} from './composerCompletion'

const cmd = (name: string, description = '', extra: Partial<AgentChatCommand> = {}): AgentChatCommand => ({ name, description, builtin: false, ...extra })

describe('completionTriggerAt', () => {
  it('opens "/" only at the start of the message', () => {
    expect(completionTriggerAt('/com', 4)).toEqual({ kind: 'slash', query: 'com', start: 0, end: 4 })
    expect(completionTriggerAt('  /', 3)).toEqual({ kind: 'slash', query: '', start: 2, end: 3 })
    expect(completionTriggerAt('see /usr', 8)).toBeNull()
    expect(completionTriggerAt('/compact now', 12)).toBeNull()
  })

  it('covers the whole command word when the caret is inside it', () => {
    expect(completionTriggerAt('/compact', 3)).toEqual({ kind: 'slash', query: 'co', start: 0, end: 8 })
  })

  it('opens "@" at the start of any word, not inside a word or an e-mail', () => {
    expect(completionTriggerAt('look at @src/ma', 15)).toEqual({ kind: 'file', query: 'src/ma', start: 8, end: 15 })
    expect(completionTriggerAt('@', 1)).toEqual({ kind: 'file', query: '', start: 0, end: 1 })
    expect(completionTriggerAt('mail a@b.com', 12)).toBeNull()
    expect(completionTriggerAt('x@', 2)).toBeNull()
  })

  it('never completes a selection', () => {
    expect(completionTriggerAt('/com', 1, 4)).toBeNull()
  })
})

describe('applyCompletion', () => {
  it('slash: "/name " with the caret ready for arguments', () => {
    const t = completionTriggerAt('/co', 3)!
    expect(applyCompletion('/co', t, { value: 'compact' })).toEqual({ text: '/compact ', caret: 9 })
  })

  it('@ file: inserts the relative path and a space, keeps the rest of the text', () => {
    const text = 'read @ma and fix'
    const t = completionTriggerAt(text, 8)!
    expect(applyCompletion(text, t, { value: 'src/main.ts' })).toEqual({ text: 'read @src/main.ts and fix', caret: 17 })
  })

  it('@ folder: ends with "/" and no space so the token stays open', () => {
    const t = completionTriggerAt('@sr', 3)!
    const next = applyCompletion('@sr', t, { value: 'src', dir: true })
    expect(next).toEqual({ text: '@src/', caret: 5 })
    expect(completionTriggerAt(next.text, next.caret)).toMatchObject({ kind: 'file', query: 'src/' })
  })
})

describe('rankCommands', () => {
  const list = [cmd('compact', 'Summarize'), cmd('clear', 'Start over'), cmd('my-compact', 'Custom'), cmd('review', 'Look at the compaction'), cmd('cost', '', { aliases: ['usage'] })]

  it('prefix, then contains, then description; shorter names first', () => {
    expect(rankCommands(list, 'compact').map((c) => c.name)).toEqual(['compact', 'my-compact', 'review'])
    expect(rankCommands(list, 'c').map((c) => c.name)).toEqual(['cost', 'clear', 'compact', 'my-compact'])
  })

  it('matches aliases and lists everything for an empty query', () => {
    expect(rankCommands(list, 'usa').map((c) => c.name)).toEqual(['cost'])
    expect(rankCommands(list, '')).toHaveLength(5)
  })
})

describe('rankFiles', () => {
  const files = [{ path: 'src/main.ts', dir: false }, { path: 'src/util/a.ts', dir: false }, { path: 'README.md', dir: false }]

  it('fuzzy-ranks paths and drops unsafe or untypeable ones', () => {
    const got = rankFiles([...files, { path: '../etc/passwd', dir: false }, { path: 'a b.md', dir: false }, { path: '/abs', dir: false }], 'main')
    expect(got.map((f) => f.path)).toEqual(['src/main.ts'])
  })

  it('a drill-in query lists that folder only', () => {
    const got = rankFiles(withParentDirs(files), 'src/').map((f) => f.path)
    expect(got.sort()).toEqual(['src/main.ts', 'src/util', 'src/util/a.ts'])
  })

  it('withParentDirs adds each folder once', () => {
    expect(withParentDirs(files).filter((f) => f.dir).map((f) => f.path)).toEqual(['src', 'src/util'])
  })
})

describe('agentChatCompletion', () => {
  const searchFiles = vi.fn(async () => [{ path: 'src/main.ts', dir: false }])

  it('lists server commands with hint and badge', async () => {
    const c = agentChatCompletion({ loadCommands: async () => [cmd('review', 'Review a PR', { argumentHint: '<pr>' }), cmd('mcp__gh__issues', 'Issues'), cmd('clear', 'Clear', { builtin: true })], searchFiles })
    const items = await c.provider(completionTriggerAt('/', 1)!)
    expect(items).toEqual([
      { value: 'clear', description: 'Clear', argumentHint: undefined, badge: 'built-in' },
      { value: 'review', description: 'Review a PR', argumentHint: '<pr>', badge: 'custom' },
      { value: 'mcp__gh__issues', description: 'Issues', argumentHint: undefined, badge: 'MCP' },
    ])
  })

  it('falls back to the built-in list when loadCommands rejects or is empty, and asks again next time', async () => {
    const loadCommands = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([]).mockResolvedValue([cmd('deploy')])
    const c = agentChatCompletion({ loadCommands, searchFiles })
    const t = completionTriggerAt('/', 1)!
    expect((await c.provider(t)).map((i) => i.value).sort()).toEqual(FALLBACK_COMMANDS.map((f) => f.name).sort())
    expect((await c.provider(t))).toHaveLength(FALLBACK_COMMANDS.length)
    expect((await c.provider(t)).map((i) => i.value)).toEqual(['deploy'])
    expect(loadCommands).toHaveBeenCalledTimes(3)
  })

  it('reuses a loaded catalog for CATALOG_REUSE_MS', async () => {
    let clock = 0
    const loadCommands = vi.fn(async () => [cmd('a')])
    const c = agentChatCompletion({ loadCommands, searchFiles }, () => clock)
    const t = completionTriggerAt('/', 1)!
    await c.provider(t)
    await c.provider(t)
    expect(loadCommands).toHaveBeenCalledTimes(1)
    clock = CATALOG_REUSE_MS + 1
    await c.provider(t)
    expect(loadCommands).toHaveBeenCalledTimes(2)
  })

  it('"@" lists files and their folders, folders tagged', async () => {
    const c = agentChatCompletion({ loadCommands: async () => [], searchFiles })
    const items = await c.provider(completionTriggerAt('@sr', 3)!)
    expect(searchFiles).toHaveBeenCalledWith('sr')
    expect(items).toContainEqual({ value: 'src', dir: true, badge: 'folder' })
    expect(items).toContainEqual({ value: 'src/main.ts', dir: false })
  })

  it('a failing file search rejects (the menu shows it as an error)', async () => {
    const c = agentChatCompletion({ loadCommands: async () => [], searchFiles: async () => { throw new Error('offline') } })
    await expect(c.provider(completionTriggerAt('@', 1)!)).rejects.toThrow('offline')
  })
})
