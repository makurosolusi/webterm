// Canvas link capture, server side: browser node choice (cabled / added + cabled), tab limit, notices, refusals, log redaction.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { BrowserTab, BrowserTabsState } from '../../shared/browser.tabs'
import type { Workspace } from '../../shared/workspace'
import type { CanvasPush } from '../canvas/canvasPush'
import { createNavigationGuard } from './navigation.guard'
import { openAgentBrowser } from './browser.agentOpen'
import { openLinkInCanvas } from './browser.linkOpen'
import type { LinkOpenDeps } from './browser.linkOpen'

const logged = vi.hoisted(() => [] as unknown[][])
vi.mock('../logs', () => ({ createLogger: () => ({ info: (...a: unknown[]) => { logged.push(a) }, warn: (...a: unknown[]) => { logged.push(a) }, error: (...a: unknown[]) => { logged.push(a) }, debug: () => {} }) }))

const WEBTERM_PORT = 8700
let board: Workspace
let tabs: Record<string, BrowserTab[]>
let calls: string[]
let sent: unknown[]
let ids: number
const tab = (n: number): BrowserTab => ({ tabId: `t${n}`, url: `https://e.example/${n}`, title: '', loading: false, discarded: false, crashed: false } as unknown as BrowserTab)
const state = (id: string): BrowserState => ({ id, url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
const canvas: Pick<CanvasPush, 'add' | 'workspaceOfNode'> = {
  add(input) { board.nodes.push(...input.nodes); board.bridges.push(...(input.bridges ?? [])); return { ok: true, updatedAt: 1, nodes: input.nodes } },
  workspaceOfNode: (id) => (board.nodes.some((n) => n.id === id) ? board : null),
}
const guard = createNavigationGuard({ allow: new Set(), webtermPort: WEBTERM_PORT, allowLoopback: true })

function deps(over: Partial<LinkOpenDeps> = {}): LinkOpenDeps {
  return {
    guard: (u) => guard.check(u),
    open: (origin) => openAgentBrowser({ canvas: async () => canvas, start: async (id) => state(id), newId: () => `nb${++ids}` }, origin, () => true, 'cabled'),
    workspaceOf: (id) => (board.nodes.some((n) => n.id === id) ? board.id : undefined),
    tabsOf: (id) => ({ tabs: tabs[id] ?? [], activeTabId: null, agentTabId: null, closed: [] }) as unknown as BrowserTabsState,
    newTab: async (id, url) => { calls.push(`new ${id} ${url}`) },
    reuseTab: async (id, tabId, url) => { calls.push(`reuse ${id} ${tabId} ${url}`) },
    notify: (m) => { sent.push(m) },
    ...over,
  }
}

beforeEach(() => {
  board = { id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, bridges: [], nodes: [{ id: 'term1', kind: 'terminal', x: 0, y: 0 }] }
  tabs = {}; calls = []; sent = []; ids = 0; logged.length = 0
})

describe('browser node choice', () => {
  it('a plain terminal with no browser gets one added beside it, cabled, and the link opens as a tab in it', async () => {
    const r = await openLinkInCanvas(deps(), 'term1', 'https://github.com/login/device')
    expect(r).toEqual({ status: 200, body: { ok: true, mode: 'canvas', nodeId: 'nb1', created: true } })
    expect(board.nodes.find((n) => n.id === 'nb1')).toMatchObject({ kind: 'browser' })
    expect(board.bridges).toEqual([{ id: 'bridge-term1-nb1', source: 'term1', target: 'nb1', kind: 'context' }])
    expect(calls).toEqual(['new nb1 https://github.com/login/device'])
  })

  it('a cabled browser is reused, no second node, and the next link goes to the same one', async () => {
    await openLinkInCanvas(deps(), 'term1', 'https://a.example/')
    const again = await openLinkInCanvas(deps(), 'term1', 'https://b.example/')
    expect(again.body).toMatchObject({ nodeId: 'nb1', created: false })
    expect(board.nodes.filter((n) => n.kind === 'browser')).toHaveLength(1)
    expect(calls).toEqual(['new nb1 https://a.example/', 'new nb1 https://b.example/'])
  })

  it('agent control being off does not stop a human sign-in link', async () => {
    const r = await openLinkInCanvas(deps(), 'term1', 'https://a.example/')
    expect(r.status).toBe(200)
  })

  it('a node that is on no board is refused', async () => {
    expect(await openLinkInCanvas(deps(), 'ghost', 'https://a.example/')).toMatchObject({ status: 404, body: { error: 'not_on_board' } })
  })
})

describe('tabs', () => {
  it('at the 8-tab limit the last tab is reused and the answer says so', async () => {
    await openLinkInCanvas(deps(), 'term1', 'https://a.example/')
    tabs.nb1 = [1, 2, 3, 4, 5, 6, 7, 8].map(tab)
    const r = await openLinkInCanvas(deps(), 'term1', 'https://b.example/')
    expect(calls.at(-1)).toBe('reuse nb1 t8 https://b.example/')
    expect(r.body).toMatchObject({ reusedTab: 't8', note: expect.stringContaining('last tab was reused') })
  })

  it('a full live-browser gate becomes a visible refusal, not a silent fallback', async () => {
    const r = await openLinkInCanvas(deps({ newTab: async () => { throw new BlockedError('max_live') } }), 'term1', 'https://a.example/')
    expect(r).toMatchObject({ status: 409, body: { error: 'max_live', message: expect.stringContaining('live browser limit') } })
    expect(sent).toEqual([])
  })

  it('an unexpected failure answers 502 with no URL or page text', async () => {
    const r = await openLinkInCanvas(deps({ newTab: async () => { throw new Error('boom https://secret.example/?t=1') } }), 'term1', 'https://a.example/')
    expect(r.status).toBe(502)
    expect(JSON.stringify(r)).not.toContain('secret')
  })
})

describe('what is accepted', () => {
  it('localhost callbacks (OAuth) pass; the webterm port itself is refused', async () => {
    expect((await openLinkInCanvas(deps(), 'term1', 'http://localhost:51234/callback?code=x')).status).toBe(200)
    expect(await openLinkInCanvas(deps(), 'term1', `http://localhost:${WEBTERM_PORT}/api/x`)).toMatchObject({ status: 403, body: { error: 'blocked' } })
  })

  it.each([['mailto:a@b.c'], ['file:///etc/passwd'], ['javascript:alert(1)'], ['ftp://x.example/']])('%s is refused as an unsupported scheme', async (url) => {
    expect(await openLinkInCanvas(deps(), 'term1', url)).toMatchObject({ status: 400, body: { error: 'unsupported_scheme' } })
  })

  it.each([[undefined], [''], ['not a url'], [42], ['https://user:pw@example.com/']])('%j is a bad url', async (url) => {
    expect((await openLinkInCanvas(deps(), 'term1', url)).status).toBe(400)
  })

  it('a preset-locked origin may only open public pages', async () => {
    const d = deps({ presetOf: () => 'skill-author' })
    expect((await openLinkInCanvas(d, 'term1', 'http://localhost:3000/')).status).toBe(403)
    expect((await openLinkInCanvas(d, 'term1', 'https://public.example/')).status).toBe(200)
  })
})

describe('notice and log', () => {
  it('tells the UI the host only (never the query) and asks it to reveal the node politely', async () => {
    await openLinkInCanvas(deps(), 'term1', 'https://auth.example/device?user_code=SECRET-1234')
    expect(sent).toEqual([
      { t: 'linkOpened', workspaceId: 'w1', nodeId: 'nb1', host: 'auth.example', created: true },
      { t: 'view', workspaceId: 'w1', nodeId: 'nb1', polite: true },
    ])
  })

  it('the log line carries the host, never the URL or its token', async () => {
    await openLinkInCanvas(deps(), 'term1', 'https://auth.example/device?user_code=SECRET-1234')
    const text = JSON.stringify(logged)
    expect(text).toContain('auth.example')
    expect(text).not.toContain('SECRET-1234')
    expect(text).not.toContain('user_code')
  })
})
