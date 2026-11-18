import { describe, expect, it } from 'vitest'
import { validPersistedTabs } from './browser.tabs'
import { normalizeWorkspace } from './workspace.schema'

const tab = (n: number) => ({ tabId: `t${n}`, url: `https://s${n}.test/`, title: `S${n}` })

describe('persisted tabs', () => {
  it('keeps good tabs, drops junk/duplicates/bad urls, caps at 8 and repairs the cursors', () => {
    const raw = { tabs: [...Array.from({ length: 10 }, (_, i) => tab(i)), tab(0), { tabId: 'x', url: 'javascript:alert(1)' }, 5], activeTabId: 'gone', agentTabId: 't2' }
    const v = validPersistedTabs(raw)!
    expect(v.tabs).toHaveLength(8)
    expect(v.activeTabId).toBe('t0')
    expect(v.agentTabId).toBe('t2')
  })

  it('only accepts http(s) favicon urls (no data: blobs)', () => {
    const v = validPersistedTabs({ tabs: [{ ...tab(1), favicon: 'data:image/png;base64,AAAA' }, { ...tab(2), favicon: 'https://f.test/i.ico' }], activeTabId: 't1', agentTabId: 't1' })!
    expect(v.tabs.map((t) => t.favicon)).toEqual([undefined, 'https://f.test/i.ico'])
  })

  it('rejects non-objects and empty lists (node falls back to one tab)', () => {
    expect(validPersistedTabs(undefined)).toBeUndefined()
    expect(validPersistedTabs({ tabs: [] })).toBeUndefined()
  })

  it('a board node carries tabs through normalizeWorkspace and loses bad ones', () => {
    const board = (tabs: unknown) => normalizeWorkspace({ name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'b', kind: 'browser', x: 0, y: 0, tabs }] }).board.nodes[0]
    expect(board({ tabs: [tab(1)], activeTabId: 't1', agentTabId: 't1' }).tabs?.tabs).toHaveLength(1)
    expect(board('garbage').tabs).toBeUndefined()
  })
})
