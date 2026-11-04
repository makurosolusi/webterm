// The delivery gate with a fake session: idle + empty input → typed then submitted once; busy or a
// draft → queued until it clears; net-zero changes say nothing; additionalContext never repeats it.
import { describe, expect, it } from 'vitest'
import type { AgentStatus, Workspace } from '../shared/workspace'
import { LinkNoteDelivery } from './linkNoteDelivery'
import { nextBrowserNotice, linkedBrowsers } from './linkAwareness'

const RULE = '─'.repeat(40)
/** A Claude Code bottom box; `draft` undefined = dim placeholder (empty composer). */
const box = (draft?: string): string =>
  ['', RULE, draft === undefined ? '❯ \x1b[2mTry "fix typecheck errors"\x1b[22m' : `❯ ${draft}`, RULE, '  ? for shortcuts'].join('\n')

function rig(id = `a-${Math.random()}`) {
  const ws = {
    nodes: [{ id, kind: 'agent', agentId: 'claude', title: 'Claude' }, { id: 'web1', kind: 'browser', title: 'Browser' }],
    bridges: [],
  } as unknown as Workspace
  const st = { status: undefined as AgentStatus | undefined, draft: undefined as string | undefined, seq: 1, pid: 1, live: true }
  const writes: string[] = []
  const d = new LinkNoteDelivery({
    workspaces: () => [ws],
    sessions: {
      statusOf: () => st.status,
      screenSource: () => (st.live ? { data: '', seq: st.seq, cols: 80, rows: 24, pid: st.pid } : undefined),
      input: (_id, data) => {
        writes.push(data)
        if (data === '\r') { st.draft = undefined; st.status = 'working' } else st.draft = (st.draft ?? '') + data
        st.seq++
      },
    },
    render: async () => box(st.draft),
    sleep: async () => {},
  })
  const wire = () => { ws.bridges.push({ id: 'b', source: id, target: 'web1', kind: 'context' }) }
  const unwire = () => { ws.bridges.length = 0 }
  const rename = (t: string) => { (ws.nodes[1] as { title: string }).title = t }
  return { id, ws, st, writes, d, wire, unwire, rename }
}

describe('LinkNoteDelivery', () => {
  it('connect while idle + empty input → note typed once, then a separate Enter', async () => {
    const r = rig()
    await r.d.tick() // baseline
    r.wire()
    await r.d.tick()
    expect(r.writes).toHaveLength(2)
    expect(r.writes[0]).toMatch(/^\[webterm\] The user wired browser node "Browser"/)
    expect(r.writes[1]).toBe('\r')
    r.st.status = 'waiting'
    await r.d.tick()
    expect(r.writes).toHaveLength(2) // never twice
  })

  it('while busy → queued, delivered once the turn ends (idle)', async () => {
    const r = rig()
    await r.d.tick()
    r.st.status = 'working'
    r.wire()
    await r.d.tick()
    r.st.status = 'blocked'
    await r.d.tick()
    expect(r.writes).toEqual([])
    r.st.status = 'waiting'
    await r.d.tick()
    expect(r.writes[0]).toContain('[webterm]')
  })

  it('user text in the input → not delivered until the input is empty again', async () => {
    const r = rig()
    await r.d.tick()
    r.st.draft = 'half-typed prompt'
    r.wire()
    await r.d.tick()
    await r.d.tick()
    expect(r.writes).toEqual([])
    r.st.draft = undefined
    r.st.seq++ // the user cleared it: new output
    await r.d.tick()
    expect(r.writes[0]).toContain('[webterm]')
  })

  it('connect + disconnect before delivery → nothing', async () => {
    const r = rig()
    await r.d.tick()
    r.st.status = 'working'
    r.wire()
    await r.d.tick()
    r.unwire()
    r.st.status = 'waiting'
    await r.d.tick()
    expect(r.writes).toEqual([])
  })

  it('rename of a wired browser → update note with the new title; disconnect → unwired note', async () => {
    const r = rig()
    await r.d.tick()
    r.wire()
    await r.d.tick()
    r.st.status = 'waiting'
    r.rename('makuro-browser')
    await r.d.tick()
    expect(r.writes[2]).toContain('is now titled "makuro-browser"')
    r.st.status = 'waiting'
    r.unwire()
    await r.d.tick()
    expect(r.writes[4]).toContain('Browser node "makuro-browser" (id web1) was unwired from you')
  })

  it('a delivered note is not announced again via additionalContext', async () => {
    const r = rig()
    nextBrowserNotice(r.id, 'SessionStart', linkedBrowsers(r.ws, r.id))
    await r.d.tick()
    r.wire()
    await r.d.tick()
    expect(r.writes[0]).toContain('[webterm]')
    expect(nextBrowserNotice(r.id, 'UserPromptSubmit', linkedBrowsers(r.ws, r.id))).toBeNull()
  })

  it('a change the hook already announced (markTold) is not typed afterwards', async () => {
    const r = rig()
    await r.d.tick()
    r.st.status = 'working'
    r.wire()
    r.d.markTold(r.id, r.ws) // UserPromptSubmit carried it as additionalContext
    r.st.status = 'waiting'
    await r.d.tick()
    expect(r.writes).toEqual([])
  })

  it('an Enter is withheld when the typed note never shows on screen', async () => {
    const r = rig()
    await r.d.tick()
    r.wire()
    const d = new LinkNoteDelivery({
      workspaces: () => [r.ws],
      sessions: { statusOf: () => undefined, screenSource: () => ({ data: '', seq: 1, cols: 80, rows: 24, pid: 1 }), input: (_i, x) => { r.writes.push(x) } },
      render: async () => box(),
      sleep: async () => {},
    })
    r.unwire(); await d.tick(); r.wire(); await d.tick()
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]).toContain('[webterm]')
  })

  it('a restarted PTY (new pid) re-baselines instead of announcing old changes', async () => {
    const r = rig()
    await r.d.tick()
    r.wire()
    r.st.pid = 2
    await r.d.tick()
    expect(r.writes).toEqual([])
  })
})
