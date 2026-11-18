import { describe, expect, it, vi } from 'vitest'
import type { BrowserHostApi } from '../../shared/browser.contract'
import type { DownloadItem } from '../../shared/browser.downloads'
import { DOWNLOADS_NOTE, downloadVerbs, withDownloadIds } from './browserAgent.verbs.downloads'
import type { AgentCtx, BaseVerbs } from './browserAgent.verbs.ctx'

const item = (o: Partial<DownloadItem> & { id: string }): DownloadItem => ({
  nodeId: 'n1', name: `${o.id}.pdf`, url: 'https://h.example/x', host: 'h.example', received: 10, total: 10, state: 'completed', risky: false, startedAt: 100, ...o,
})
const ctx = (items: DownloadItem[], known = true): AgentCtx => ({
  host: { state: (id: string) => (known && id === 'n1' ? { id } : undefined) } as unknown as BrowserHostApi,
  downloads: { list: (id: string) => items.filter((i) => i.nodeId === id), file: (_id: string, d: string) => ({ path: `/data/downloads/p/${d}.pdf`, name: `${d}.pdf` }) },
} as unknown as AgentCtx)

describe('downloads verb', () => {
  it('lists newest first with the path of a finished file and the page-data note', async () => {
    const r = await downloadVerbs(ctx([item({ id: 'a' }), item({ id: 'b', state: 'inProgress', received: 5, total: 20 })])).downloads('n1', {})
    expect(r.note).toBe(DOWNLOADS_NOTE)
    expect(r.downloads.map((d) => d.id)).toEqual(['b', 'a'])
    expect(r.downloads[1]).toEqual({ id: 'a', name: 'a.pdf', state: 'completed', bytes: 10, total: 10, host: 'h.example', risky: false, path: '/data/downloads/p/a.pdf' })
    expect(r.downloads[0]).toMatchObject({ id: 'b', state: 'inProgress', bytes: 5, total: 20 })
  })

  it('a file waiting for the human\'s Keep / Discard is listed without a path', async () => {
    const r = await downloadVerbs(ctx([item({ id: 'a', pending: true })])).downloads('n1', {})
    expect(r.downloads[0].path).toBeUndefined()
    expect(r.downloads[0].state).toBe('completed')
  })

  it('carries the failure reason and the risky flag', async () => {
    const r = await downloadVerbs(ctx([item({ id: 'a', state: 'failed', failure: 'too_large', risky: true, name: 'x.pkg' })])).downloads('n1', {})
    expect(r.downloads[0]).toMatchObject({ state: 'failed', failure: 'too_large', risky: true })
  })

  it('answers an empty list without downloads wiring, refuses a bad body and an unknown node', async () => {
    const bare = { host: ctx([]).host } as AgentCtx
    expect((await downloadVerbs(bare).downloads('n1', {})).downloads).toEqual([])
    await expect(downloadVerbs(ctx([])).downloads('n1', 'x')).rejects.toThrow('JSON object')
    await expect(downloadVerbs(ctx([], false)).downloads('nope', {})).rejects.toThrow('not found')
  })
})

describe('withDownloadIds', () => {
  const base = (): BaseVerbs => ({
    click: vi.fn(async () => ({ ok: true as const, newTab: 't2' })), navigate: vi.fn(async () => ({ ok: true as const })),
    type: vi.fn(async () => ({ ok: true as const })), press: vi.fn(async () => ({ ok: true as const })), scroll: vi.fn(async () => ({ ok: true as const })),
  } as unknown as BaseVerbs)

  it('adds `download: <id>` to the result of an action that started one, keeping the rest of the result', async () => {
    let clock = 1000
    const items: DownloadItem[] = [item({ id: 'old', startedAt: 500 })]
    const v = base()
    const verbs = withDownloadIds({ ...v, click: async (...a) => { const r = await (v.click as never as (n: string, b: unknown) => Promise<object>)(...a); clock += 5; items.push(item({ id: 'new', startedAt: clock })); return r as never } } as BaseVerbs, { list: (id) => items.filter((i) => i.nodeId === id) }, () => clock)
    expect(await verbs.click('n1', {})).toEqual({ ok: true, newTab: 't2', download: 'new' })
  })

  it('leaves the result alone when nothing started, and never touches verbs that cannot start a download', async () => {
    const v = base()
    const verbs = withDownloadIds(v, { list: () => [item({ id: 'old', startedAt: 1 })] }, () => 1000)
    for (const name of ['click', 'navigate', 'type', 'press'] as const) expect(await (verbs[name] as (n: string, b: unknown) => Promise<object>)('n1', {}), name).not.toHaveProperty('download')
    expect(verbs.scroll).toBe(v.scroll)
  })

  it('names the newest of several downloads an action started', async () => {
    let clock = 1000
    const items: DownloadItem[] = []
    const v = base()
    v.navigate = vi.fn(async () => { items.push(item({ id: 'a', startedAt: clock + 1 }), item({ id: 'b', startedAt: clock + 2 })); return { ok: true as const } }) as never
    const verbs = withDownloadIds(v, { list: () => items }, () => clock)
    expect(await verbs.navigate('n1', { url: 'https://x.test/f.zip' })).toEqual({ ok: true, download: 'b' })
  })
})
