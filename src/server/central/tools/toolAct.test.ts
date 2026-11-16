import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActMsg } from '../../../shared/protocol'
import type { AppendEventInput } from '../../events/eventModel'
import { ACT_COALESCE_MS, ACT_MAX_PENDING, ACT_TOOLS, type ActSink, announceCentralAct, resetActCoalescer } from './toolAct'
import type { ToolCtx } from './toolTypes'

const ctx = { conversationId: 'central:project:p1', turnId: 'turn-1', now: () => 0 } as unknown as ToolCtx // test-only: no db read without a projectId
function sink() {
  const frames: ActMsg[] = []
  const events: AppendEventInput[] = []
  const s: ActSink = { record: (e) => { events.push(e) }, broadcast: (m) => { frames.push(m) } }
  return { s, frames, events }
}
const typed = (extra: Record<string, unknown> = {}) => ({ ok: true, data: { nodeId: 'n1', name: 'Puffin', length: 9, keys: ['Enter'], ...extra } })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { resetActCoalescer(); vi.useRealTimers() })

describe('announceCentralAct', () => {
  it('emits one frame and one central.act record carrying ids and a verb only', () => {
    const { s, frames, events } = sink()
    announceCentralAct(ctx, 'canvas.type', undefined, typed({ text: 'rm -rf secret-prompt', url: 'https://x.test/?k=1' }), s)
    expect(frames).toEqual([])
    vi.advanceTimersByTime(ACT_COALESCE_MS)
    expect(frames).toEqual([{ t: 'act', v: 1, tool: 'canvas.type', verb: 'typed', nodeId: 'n1', turnId: 'turn-1', n: 1 }])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'central.act', source: 'central', trust: 'trusted', nodeId: 'n1' })
    const wire = JSON.stringify([frames, events])
    for (const leak of ['rm -rf', 'secret-prompt', 'x.test', 'Puffin', 'Enter']) expect(wire).not.toContain(leak)
  })

  it('folds a burst on one (node, verb) into one frame with a higher n; other verbs and nodes stay apart', () => {
    const { s, frames } = sink()
    for (let i = 0; i < 4; i++) announceCentralAct(ctx, 'canvas.type', undefined, typed(), s)
    announceCentralAct(ctx, 'canvas.type', undefined, typed({ nodeId: 'n2' }), s)
    announceCentralAct(ctx, 'chat.send', undefined, { ok: true, data: { nodeId: 'n1' } }, s)
    vi.advanceTimersByTime(ACT_COALESCE_MS)
    expect(frames.map((f) => `${f.nodeId}:${f.verb}:${f.n}`).sort()).toEqual(['n1:sent:1', 'n1:typed:4', 'n2:typed:1'])
  })

  it('announces nothing for a failed call, an unlisted tool, a missing or unsafe node id', () => {
    const { s, frames, events } = sink()
    announceCentralAct(ctx, 'canvas.type', undefined, { ok: false, code: 'approval_required', data: { nodeId: 'n1' } }, s)
    announceCentralAct(ctx, 'canvas.show', undefined, typed(), s)
    announceCentralAct(ctx, 'canvas.type', undefined, { ok: true, data: {} }, s)
    announceCentralAct(ctx, 'canvas.type', undefined, typed({ nodeId: '-x; rm' }), s)
    announceCentralAct(ctx, 'agent.spawn', undefined, { ok: true, data: { nodeId: 'n1', reused: true } }, s)
    vi.advanceTimersByTime(ACT_COALESCE_MS * 2)
    expect([frames, events]).toEqual([[], []])
  })

  it('reads the node from each tool result shape', () => {
    const { s, frames } = sink()
    announceCentralAct(ctx, 'canvas.open', undefined, { ok: true, data: { ids: ['e1', 'e2'] } }, s)
    announceCentralAct(ctx, 'canvas.close', undefined, { ok: true, data: { ids: ['t9'] } }, s)
    announceCentralAct(ctx, 'canvas.edit', undefined, { ok: true, data: { ids: ['m1'], wired: [['a1', 'b1']] } }, s)
    announceCentralAct(ctx, 'canvas.edit', undefined, { ok: true, data: { ids: ['m1'], wired: [] } }, s)
    announceCentralAct(ctx, 'browser_open', undefined, { ok: true, data: { nodeId: 'br-1', agentNode: 'c-a1' } }, s)
    announceCentralAct(ctx, 'browser_act', undefined, { ok: true, data: { nodeId: 'br-1', action: 'navigate', host: 'example.com' } }, s)
    announceCentralAct(ctx, 'browser_read', undefined, { ok: true, data: { nodeId: 'br-2', host: 'example.com', answer: 'x', tainted: true } }, s)
    vi.advanceTimersByTime(ACT_COALESCE_MS)
    expect(frames.map((f) => [f.verb, f.nodeId, f.nodeId2, f.host])).toEqual([
      ['opened', 'e1', undefined, undefined], ['closed', 't9', undefined, undefined], ['wired', 'a1', 'b1', undefined],
      ['opened', 'br-1', 'c-a1', undefined], ['drove', 'br-1', undefined, 'example.com'], ['drove', 'br-2', undefined, undefined],
    ])
  })

  it('bounds held entries: past the cap a call is sent at once', () => {
    const { s, frames } = sink()
    for (let i = 0; i < ACT_MAX_PENDING; i++) announceCentralAct(ctx, 'canvas.type', undefined, typed({ nodeId: `cap${i}` }), s)
    announceCentralAct(ctx, 'canvas.type', undefined, typed({ nodeId: 'over' }), s)
    expect(frames.map((f) => f.nodeId)).toEqual(['over'])
  })

  it('a failing record or broadcast never throws and the other side still goes out', () => {
    const frames: ActMsg[] = []
    const bad: ActSink = { record: () => { throw new Error('ledger down') }, broadcast: (m) => { frames.push(m) } }
    expect(() => { announceCentralAct(ctx, 'canvas.type', undefined, typed(), bad); vi.advanceTimersByTime(ACT_COALESCE_MS) }).not.toThrow()
    expect(frames).toHaveLength(1)
    const dead: ActSink = { record: () => {}, broadcast: () => { throw new Error('socket') } }
    expect(() => { announceCentralAct(ctx, 'chat.send', undefined, { ok: true, data: { nodeId: 'n7' } }, dead); vi.advanceTimersByTime(ACT_COALESCE_MS) }).not.toThrow()
  })

  it('lists every tool of the spec with a verb', () => {
    expect(Object.keys(ACT_TOOLS)).toEqual(expect.arrayContaining(['agent.spawn', 'agent.prompt', 'agent.relay', 'agent.close', 'canvas.open', 'canvas.type', 'canvas.close', 'canvas.edit', 'browser_open', 'browser_act', 'browser_read', 'chat.send', 'permission.decide', 'task.assign']))
    expect(ACT_TOOLS['canvas.show']).toBeUndefined()
  })
})
