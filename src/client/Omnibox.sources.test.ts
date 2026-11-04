import { describe, expect, it } from 'vitest'
import { omniboxItems, omniMode, searchItems, GROUP_CAP, type OmniSources } from './Omnibox.sources'
import { rankWithHistory, recentUnder } from './QuickOpen.recency'
import { addressUrl } from './Omnibox.open'

const src = (over: Partial<OmniSources> = {}): OmniSources => ({
  nodes: [{ id: 'n1', label: 'api server', hint: 'terminal' }, { id: 'n2', label: 'docs', hint: 'browser' }],
  commands: [{ id: 'workbench.findInFiles', label: 'Search: Find in Files', keybinding: '⇧⌘F' }, { id: 'view.fit', label: 'View: Fit Canvas' }],
  agents: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }],
  recentUrls: [{ url: 'https://example.com/docs', host: 'example.com', title: 'Example docs' }],
  files: ['src/server/api.ts', 'src/client/App.tsx', 'README.md'],
  recentFiles: [],
  asUrl: addressUrl,
  ...over,
})
const ids = (q: string, s = src(), scope: 'all' | 'files' = 'all') => omniboxItems(q, scope, s).map((i) => i.id)

describe('quick open ranking (recency first, Orca quick-open-history-ranking)', () => {
  const files = ['src/a.ts', 'src/app.ts', 'lib/apple.ts', 'gone.ts']
  it('puts matching recent files first, newest first, then fuzzy matches', () => {
    expect(rankWithHistory('ap', [...files, 'map.ts'], ['lib/apple.ts', 'src/app.ts'], 10)).toEqual(['lib/apple.ts', 'src/app.ts', 'map.ts'])
  })
  it('drops history entries that no longer exist or do not match', () => {
    expect(rankWithHistory('app', files.slice(0, 3), ['gone.ts', 'src/a.ts', 'src/app.ts'], 10)).toEqual(['src/app.ts', 'lib/apple.ts'])
  })
  it('empty query lists recent files first, then the rest, capped', () => {
    expect(rankWithHistory('', files, ['gone.ts', 'src/app.ts'], 3)).toEqual(['gone.ts', 'src/app.ts', 'src/a.ts'])
  })
  it('maps absolute history to root-relative entries under that root only', () => {
    expect(recentUnder('/w/p', ['/w/p/src/a.ts', '/w/other/x.ts', '/w/p2/y.ts'])).toEqual(['src/a.ts'])
  })
})

describe('omnibox sources', () => {
  it('modes come from the prefix, like VS Code Quick Open', () => {
    expect(omniMode('>fit', 'all')).toBe('commands')
    expect(omniMode('%needle', 'files')).toBe('search')
    expect(omniMode('app', 'files')).toBe('files')
    expect(omniMode('app', 'all')).toBe('mixed')
  })

  it('empty ⌘K lists nodes, agents, recent URLs and commands — not the whole file tree', () => {
    const all = ids('')
    expect(all).toContain('node:n1')
    expect(all).toContain('agent:claude')
    expect(all).toContain('url:https://example.com/docs')
    expect(all).toContain('command:view.fit')
    expect(all.some((id) => id.startsWith('file:'))).toBe(false)
  })

  it('a typed query mixes nodes, files and agents from every source', () => {
    expect(ids('api')).toEqual(expect.arrayContaining(['node:n1', 'file:src/server/api.ts']))
    expect(ids('clau')).toContain('agent:claude')
    expect(ids('clau')).not.toContain('agent:codex')
  })

  it('an address offers "Open in Browser" first; a phrase does not', () => {
    const items = omniboxItems('localhost:5173', 'all', src())
    expect(items[0].action).toEqual({ kind: 'url', url: 'http://localhost:5173/' })
    expect(ids('fit canvas')).not.toContain('url:typed')
    expect(ids('localhost:5173', src({ asUrl: () => null }))).not.toContain('url:typed') // browser feature off
  })

  it('a typed phrase offers "Plan: …" (draft only); one word, commands and ⌘P do not', () => {
    const plan = omniboxItems('add a login form', 'all', src()).find((i) => i.id === 'plan:typed')
    expect(plan).toMatchObject({ label: 'Plan: add a login form', group: 'Plan', action: { kind: 'plan', intent: 'add a login form' } })
    expect(ids('api')).not.toContain('plan:typed')
    expect(ids('>fit canvas')).not.toContain('plan:typed')
    expect(ids('add login', src(), 'files')).not.toContain('plan:typed')
  })

  it('> lists only commands; ⌘P scope lists only files, recent first', () => {
    expect(ids('>find')).toEqual(['command:workbench.findInFiles'])
    const files = omniboxItems('', 'files', src({ recentFiles: ['README.md'] }))
    expect(files.map((i) => i.id)).toEqual(['file:README.md', 'file:src/server/api.ts', 'file:src/client/App.tsx'])
    expect(files[0].group).toBe('Recently opened')
    expect(files[1]).toMatchObject({ label: 'api.ts', description: 'src/server' })
  })

  it('caps big workspaces per group', () => {
    const many = Array.from({ length: 500 }, (_, i) => `f/file${i}.ts`)
    expect(omniboxItems('file', 'files', src({ files: many })).length).toBe(GROUP_CAP.filesOnly)
    expect(omniboxItems('file', 'all', src({ files: many })).filter((i) => i.group === 'Files').length).toBe(GROUP_CAP.files)
  })

  it('text search rows open the file at the line, with a Load more row while pages remain', () => {
    const rows = searchItems([{ file: 'a.ts', line: 3, col: 5, text: '  const x' }], true)
    expect(rows[0]).toMatchObject({ label: 'const x', description: 'a.ts:3', action: { kind: 'file', rel: 'a.ts', line: 3, col: 5 } })
    expect(rows[1].action).toEqual({ kind: 'more' })
    expect(searchItems([], false)).toEqual([])
  })
})
