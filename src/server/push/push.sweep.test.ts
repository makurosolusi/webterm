import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SenseEvent } from '../events/eventModel'
import type { InboxEntry } from '../inbox/inboxItemModel'
import { parseSubscription, readPushState, writePushState } from './push.store'
import { hookPushListener, resetBriefThrottle, sweepWebPush, type WebPushDeps } from './push.sweep'
import { fakeBrowser, recordingFetch, type FakeBrowser } from './push.testutil'
import { generateVapidKeys, type VapidKeys } from './webPush.crypto'

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' // test-only fake token shape
let keys: VapidKeys
let browser: FakeBrowser

const item = (over: Partial<InboxEntry>): InboxEntry => ({
  id: 'gate_1', kind: 'gate', source: 'approval', projectId: 'p', workspaceId: 'ws1', nodeId: 'n1', approvalId: 'gate_1', approvalKind: 'agent.permission',
  title: 'Claude wants to run: Bash(git push)', body: `export GH_TOKEN=${SECRET}`, impact: { what: 'Runs git push', tier: 'R3', rewindable: false },
  args: { command: `curl -H "Authorization: Bearer ${SECRET}"` }, status: 'open', resolution: null, snoozeUntil: null, count: 1,
  actions: ['approve', 'deny'], createdAt: 1, updatedAt: 1, ...over,
})

function setup(opts: { items?: InboxEntry[]; watching?: (i: { nodeId: string | null }) => boolean; muted?: string[]; status?: (url: string) => number; hour?: number; away?: number; brief?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-push-'))
  const statePath = join(dir, 'push-subscriptions.json')
  const sub = parseSubscription(browser.subscription())!
  writePushState(statePath, { subs: [sub], sent: [], briefDay: null })
  const rec = recordingFetch(opts.status)
  let items = opts.items ?? []
  const now = new Date(2026, 10, 5, opts.hour ?? 10, 0, 0).getTime()
  const deps: WebPushDeps = {
    statePath, keys: async () => keys, fetch: rec.fetch, now: () => now,
    items: () => items,
    attention: { watching: opts.watching ?? (() => false), muted: (ws) => (opts.muted ?? []).includes(ws) },
    awayMs: () => opts.away ?? 0,
    ...(opts.brief === undefined ? {} : { briefText: async () => opts.brief! }),
  }
  return { deps, rec, statePath, sub, setItems: (next: InboxEntry[]) => { items = next } }
}

beforeEach(async () => {
  keys ??= await generateVapidKeys()
  browser = await fakeBrowser()
  resetBriefThrottle()
})

describe('sweepWebPush', () => {
  it('pushes a gate once, high urgency, with only id/kind/title/url and no secrets', async () => {
    const t = setup({ items: [item({ title: `Claude wants to run: Bash(TOKEN=${SECRET} deploy)` })] })
    expect(await sweepWebPush(t.deps)).toEqual({ pushed: ['gate_1'], held: [] })
    expect(t.rec.sent).toHaveLength(1)
    const req = t.rec.sent[0]!
    expect(req.url).toBe(t.sub.endpoint)
    expect(req.headers['Urgency']).toBe('high')
    expect(req.headers['Content-Encoding']).toBe('aes128gcm')
    expect(req.headers['Authorization']).toMatch(/^vapid t=.+, k=/)
    const payload = await browser.decrypt(req.body) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['id', 'kind', 'title', 'url'])
    expect(payload).toMatchObject({ id: 'gate_1', kind: 'gate', url: '/m/#inbox' })
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(JSON.stringify(payload)).not.toContain('curl')
    // Second sweep: already sent.
    expect(await sweepWebPush(t.deps)).toEqual({ pushed: [], held: [] })
    expect(t.rec.sent).toHaveLength(1)
  })

  it('holds while the desktop tab is on that node, then pushes once the user walks away', async () => {
    let watching = true
    const t = setup({ items: [item({})], watching: () => watching })
    expect(await sweepWebPush(t.deps)).toEqual({ pushed: [], held: ['gate_1'] })
    expect(t.rec.sent).toHaveLength(0)
    watching = false
    expect((await sweepWebPush(t.deps)).pushed).toEqual(['gate_1'])
  })

  it('never pushes plain news or muted-workspace questions; gates ignore the mute', async () => {
    const t = setup({
      muted: ['ws1'],
      items: [item({ id: 'n', kind: 'notify', source: 'agent' }), item({ id: 'q', kind: 'question', source: 'agent' }), item({ id: 'g' })],
    })
    expect((await sweepWebPush(t.deps)).pushed).toEqual(['g'])
    expect(await sweepWebPush(t.deps)).toEqual({ pushed: [], held: [] })
    expect(t.rec.sent).toHaveLength(1)
  })

  it('pushes a snoozed item again when it resurfaces', async () => {
    const t = setup({ items: [item({})] })
    await sweepWebPush(t.deps)
    t.setItems([]) // snoozed: out of the open list
    await sweepWebPush(t.deps)
    t.setItems([item({})])
    expect((await sweepWebPush(t.deps)).pushed).toEqual(['gate_1'])
    expect(t.rec.sent).toHaveLength(2)
  })

  it('forgets a subscription the push service reports gone (410)', async () => {
    const t = setup({ items: [item({})], status: () => 410 })
    expect((await sweepWebPush(t.deps)).pushed).toEqual([])
    expect(readPushState(t.statePath).subs).toEqual([])
  })

  it('does nothing at all without subscriptions', async () => {
    const t = setup({ items: [item({})] })
    writePushState(t.statePath, { subs: [], sent: [], briefDay: null })
    let keyReads = 0
    expect(await sweepWebPush({ ...t.deps, keys: async () => { keyReads += 1; return keys } })).toEqual({ pushed: [], held: [] })
    expect(keyReads).toBe(0)
    expect(t.rec.sent).toHaveLength(0)
  })

  it('sends "brief ready" once per day, only after 07:00 and after being away', async () => {
    const brief = 'Morning brief since x\n\nStuck\n- a\n- b'
    const early = setup({ brief, hour: 6, away: 3_600_000 })
    await sweepWebPush(early.deps)
    expect(early.rec.sent).toHaveLength(0)
    const here = setup({ brief, away: 0 })
    await sweepWebPush(here.deps)
    expect(here.rec.sent).toHaveLength(0)
    const t = setup({ brief, away: 3_600_000 })
    await sweepWebPush(t.deps)
    expect(t.rec.sent).toHaveLength(1)
    expect(await browser.decrypt(t.rec.sent[0]!.body)).toMatchObject({ kind: 'brief', title: 'Morning brief ready: 2 updates', url: '/m/#brief' })
    resetBriefThrottle()
    await sweepWebPush(t.deps)
    expect(t.rec.sent).toHaveLength(1)
  })
})

describe('hookPushListener', () => {
  const ev = (nodeId: string, status: string, seq: number): SenseEvent =>
    ({ seq, ts: seq, kind: 'hook.Stop', nodeId, workspaceId: 'ws1', payload: { status, preview: SECRET } }) as unknown as SenseEvent
  const settle = () => new Promise((r) => setTimeout(r, 50))

  it('pushes a transition to waiting once, never while the tab is on that node', async () => {
    const t = setup({ watching: (i) => i.nodeId === 'watched' })
    const on = hookPushListener({ ...t.deps, label: (id) => `Claude ${id}` })
    on(ev('n1', 'working', 1))
    on(ev('n1', 'waiting', 2))
    on(ev('n1', 'waiting', 3)) // repeat: not news
    on(ev('watched', 'waiting', 4))
    await settle()
    expect(t.rec.sent).toHaveLength(1)
    const payload = await browser.decrypt(t.rec.sent[0]!.body)
    expect(payload).toEqual({ id: 'agent:n1:2', kind: 'agent', title: 'Claude n1 needs input', url: '/m/#agents' })
  })
})
