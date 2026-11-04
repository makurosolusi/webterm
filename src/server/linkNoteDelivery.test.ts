// Link notes through the REAL outbox (node:sqlite store) with a fake session: idle + empty input →
// typed then submitted once; busy or a draft → queued until it clears; net-zero changes say
// nothing (the queued note is cancelled); additionalContext never repeats a delivered note.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, Workspace } from '../shared/workspace'
import { LinkNoteDelivery, subscribeLinkNotes } from './linkNoteDelivery'
import { produceEdgeChange } from './events/producers.edge'
import { produceHookEvent } from './events/producers'
import { eventBus } from './events/eventBus'
import { nextBrowserNotice, linkedBrowsers } from './linkAwareness'
import { nodeSqlite } from './nodeSqlite.testutil'
import { DDL_V12 } from './ledger/ledgerSchemaV12'
import { agentIn, OutboxDelivery, subscribeOutbox } from './outbox/outboxDelivery'
import { createOutboxStore } from './outbox/outboxStore'

const RULE = '─'.repeat(40)
/** A Claude Code bottom box; `draft` undefined = dim placeholder (empty composer). */
const box = (draft?: string): string =>
  ['', RULE, draft === undefined ? '❯ \x1b[2mTry "fix typecheck errors"\x1b[22m' : `❯ ${draft}`, RULE, '  ? for shortcuts'].join('\n')

function rig(id = `a-${Math.random()}`) {
  const ws = {
    nodes: [{ id, kind: 'agent', agentId: 'claude', title: 'Claude' }, { id: 'web1', kind: 'browser', title: 'Browser' }],
    bridges: [],
  } as unknown as Workspace
  const st = { status: undefined as AgentStatus | undefined, draft: undefined as string | undefined, seq: 1, pid: 1, live: true, echo: true }
  const writes: string[] = []
  const { db } = nodeSqlite()
  db.exec(DDL_V12)
  const sessions = {
    statusOf: () => st.status,
    screenSource: () => (st.live ? { data: '', seq: st.seq, cols: 80, rows: 24, pid: st.pid } : undefined),
    input: (_id: string, data: string) => {
      writes.push(data)
      if (data === '\r') { st.draft = undefined; st.status = 'working' } else if (st.echo) st.draft = (st.draft ?? '') + data
      st.seq++
    },
  }
  const outbox = new OutboxDelivery({
    store: createOutboxStore(db), agentOf: (n) => agentIn([ws], n), sessions, record: () => {},
    render: async () => box(st.draft), sleep: async () => {},
  })
  const d = new LinkNoteDelivery({ workspaces: () => [ws], sessions, outbox })
  /** One linkNote pass, then let the outbox finish delivering. */
  const tick = async () => { await d.tick(); await outbox.kick(id) }
  const wire = () => { ws.bridges.push({ id: 'b', source: id, target: 'web1', kind: 'context' }) }
  const unwire = () => { ws.bridges.length = 0 }
  const rename = (t: string) => { (ws.nodes[1] as { title: string }).title = t }
  return { id, ws, st, writes, d, outbox, tick, wire, unwire, rename }
}

describe('LinkNoteDelivery', () => {
  it('connect while idle + empty input → note typed once, then a separate Enter', async () => {
    const r = rig()
    await r.tick() // baseline
    r.wire()
    await r.tick()
    expect(r.writes).toHaveLength(2)
    expect(r.writes[0]).toMatch(/^\[webterm\] The user wired browser node "Browser"/)
    expect(r.writes[1]).toBe('\r')
    r.st.status = 'waiting'
    await r.tick()
    expect(r.writes).toHaveLength(2) // never twice
  })

  it('while busy → queued, delivered once the turn ends (idle)', async () => {
    const r = rig()
    await r.tick()
    r.st.status = 'working'
    r.wire()
    await r.tick()
    r.st.status = 'blocked'
    await r.tick()
    expect(r.writes).toEqual([])
    r.st.status = 'waiting'
    await r.tick()
    expect(r.writes[0]).toContain('[webterm]')
  })

  it('user text in the input → not delivered until the input is empty again', async () => {
    const r = rig()
    await r.tick()
    r.st.draft = 'half-typed prompt'
    r.wire()
    await r.tick()
    await r.tick()
    expect(r.writes).toEqual([])
    r.st.draft = undefined
    r.st.seq++ // the user cleared it: new output
    await r.tick()
    expect(r.writes[0]).toContain('[webterm]')
  })

  it('connect + disconnect before delivery → nothing', async () => {
    const r = rig()
    await r.tick()
    r.st.status = 'working'
    r.wire()
    await r.tick()
    r.unwire()
    r.st.status = 'waiting'
    await r.tick()
    expect(r.writes).toEqual([])
  })

  it('rename of a wired browser → update note with the new title; disconnect → unwired note', async () => {
    const r = rig()
    await r.tick()
    r.wire()
    await r.tick()
    r.st.status = 'waiting'
    r.rename('makuro-browser')
    await r.tick()
    expect(r.writes[2]).toContain('is now titled "makuro-browser"')
    r.st.status = 'waiting'
    r.unwire()
    await r.tick()
    expect(r.writes[4]).toContain('Browser node "makuro-browser" (id web1) was unwired from you')
  })

  it('a delivered note is not announced again via additionalContext', async () => {
    const r = rig()
    nextBrowserNotice(r.id, 'SessionStart', linkedBrowsers(r.ws, r.id))
    await r.tick()
    r.wire()
    await r.tick()
    expect(r.writes[0]).toContain('[webterm]')
    expect(nextBrowserNotice(r.id, 'UserPromptSubmit', linkedBrowsers(r.ws, r.id))).toBeNull()
  })

  it('a change the hook already announced (markTold) is not typed afterwards', async () => {
    const r = rig()
    await r.tick()
    r.st.status = 'working'
    r.wire()
    r.d.markTold(r.id, r.ws) // UserPromptSubmit carried it as additionalContext
    r.st.status = 'waiting'
    await r.tick()
    expect(r.writes).toEqual([])
  })

  it('an Enter is withheld when the typed note never shows on screen (outbox marks it failed)', async () => {
    const r = rig()
    await r.tick()
    r.st.echo = false // the PTY swallows the text: the composer stays empty
    r.wire()
    await r.tick()
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]).toContain('[webterm]')
    expect(r.outbox.list(r.id)[0]).toMatchObject({ status: 'failed' })
  })

  it('a queued note is superseded by the current net change, never typed stale', async () => {
    const r = rig()
    await r.tick()
    r.st.status = 'working'
    r.wire()
    await r.tick()
    r.rename('renamed-before-delivery')
    await r.tick()
    r.st.status = 'waiting'
    await r.tick()
    expect(r.writes).toHaveLength(2)
    expect(r.writes[0]).toContain('"renamed-before-delivery"')
    expect(r.outbox.list(r.id).map((m) => m.status).sort()).toEqual(['cancelled', 'delivered'])
  })

  it('a restarted PTY (new pid) re-baselines instead of announcing old changes', async () => {
    const r = rig()
    await r.tick()
    r.wire()
    r.st.pid = 2
    await r.tick()
    expect(r.writes).toEqual([])
  })
})

describe('subscribeLinkNotes (event-driven, F1-d)', () => {
  afterEach(() => vi.useRealTimers())

  it('a wired cable is typed within 1 s of edge.change, with no timer at idle', async () => {
    vi.useFakeTimers()
    const r = rig()
    const off = subscribeOutbox(r.outbox, eventBus)
    const sub = subscribeLinkNotes(r.d)
    sub.kick()
    await sub.settled() // baseline pass
    expect(vi.getTimerCount()).toBe(0) // idle: no poll, no sweep
    const prev = structuredClone(r.ws)
    r.wire()
    produceEdgeChange(prev, r.ws) // what the workspace save does
    await vi.advanceTimersByTimeAsync(1000)
    await sub.settled()
    await r.outbox.kick(r.id)
    expect(r.writes[0]).toMatch(/^\[webterm\] The user wired browser node "Browser"/)
    expect(r.writes[1]).toBe('\r')
    expect(vi.getTimerCount()).toBe(0)
    sub.stop(); off()
  })

  it('a note queued while busy goes out on the idle hook (hook.Stop), not on a poll', async () => {
    const r = rig()
    const off = subscribeOutbox(r.outbox, eventBus)
    const sub = subscribeLinkNotes(r.d)
    sub.kick()
    await sub.settled()
    r.st.status = 'working'
    const prev = structuredClone(r.ws)
    r.wire()
    produceEdgeChange(prev, r.ws)
    await sub.settled()
    expect(r.writes).toEqual([])
    r.st.status = 'waiting'
    produceHookEvent({ nodeId: r.id, status: 'waiting', verified: true, body: { hook_event_name: 'PostToolUse' } })
    await sub.settled()
    await new Promise((res) => setTimeout(res, 0)) // let any (wrong) wake run
    expect(r.writes).toEqual([]) // not an idle hook
    produceHookEvent({ nodeId: r.id, status: 'waiting', verified: true, body: { hook_event_name: 'Stop' } })
    await sub.settled()
    await new Promise((res) => setTimeout(res, 0)) // the outbox's own idle-hook wake delivers it
    expect(r.writes).toHaveLength(2)
    sub.stop(); off()
  })

  it('an event during a running pass queues one more pass (never lost)', async () => {
    const r = rig()
    let calls = 0
    const tick = r.d.tick.bind(r.d)
    r.d.tick = async () => { calls++; await tick() }
    const sub = subscribeLinkNotes(r.d)
    sub.kick()
    sub.kick()
    sub.kick()
    await sub.settled()
    expect(calls).toBe(2)
    sub.stop()
  })
})
