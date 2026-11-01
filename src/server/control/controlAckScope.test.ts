// Replay key scoping: the ack key must name the node resource, not just verb + requestId.
// Otherwise a requestId reused for node B replays node A's ack and never touches B (QC S1).

import { describe, expect, it } from 'vitest'
import { ackKey } from './controlTypes'
import { harness } from './fakeControlDeps'

const REQ = 'req-same0001'

describe('ackKey scope', () => {
  it('includes the node resource and the verb', () => {
    expect(ackKey('node.prompt', 'node-a', REQ)).not.toBe(ackKey('node.prompt', 'node-b', REQ))
    expect(ackKey('node.close', 'node-a', REQ)).not.toBe(ackKey('node.close', 'node-b', REQ))
    expect(ackKey('node.prompt', 'node-a', REQ)).not.toBe(ackKey('node.close', 'node-a', REQ))
    expect(ackKey('node.prompt', 'node-a', REQ)).toBe(ackKey('node.prompt', 'node-a', REQ))
    expect(ackKey('node.prompt', 'node-a', REQ)).toContain('node:node-a')
    expect(ackKey('node.prompt', 'node-a', REQ)).toContain(REQ)
  })
})

describe('ack replay is per node', () => {
  it('does not replay a prompt ack from node A for node B with the same requestId', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    h.live.set('node-b', { output: '' })

    const first = await h.call(
      'POST',
      'prompt',
      { requestId: REQ, nodeId: 'node-a', text: 'hello A' },
      { 'x-webterm-capability': h.token('node.prompt', 'node:node-a') }
    )
    const second = await h.call(
      'POST',
      'prompt',
      { requestId: REQ, nodeId: 'node-b', text: 'hello B' },
      { 'x-webterm-capability': h.token('node.prompt', 'node:node-b') }
    )

    expect(first).toEqual({ status: 200, body: { ok: true, requestId: REQ, nodeId: 'node-a' } })
    expect(second).toEqual({ status: 200, body: { ok: true, requestId: REQ, nodeId: 'node-b' } })
    // Both nodes received their own write; B was not answered with A's ack.
    expect(h.inputs).toEqual([
      { id: 'node-a', data: 'hello A\r' },
      { id: 'node-b', data: 'hello B\r' },
    ])
  })

  it('does not replay a close ack from node A for node B with the same requestId', async () => {
    const h = harness()
    h.live.set('node-a', { output: '' })
    h.live.set('node-b', { output: '' })

    const first = await h.call(
      'POST',
      'close',
      { requestId: REQ, nodeId: 'node-a' },
      { 'x-webterm-capability': h.token('node.close', 'node:node-a') }
    )
    const second = await h.call(
      'POST',
      'close',
      { requestId: REQ, nodeId: 'node-b' },
      { 'x-webterm-capability': h.token('node.close', 'node:node-b') }
    )

    expect(first?.body).toEqual({ ok: true, requestId: REQ, nodeId: 'node-a', closed: true })
    expect(second?.body).toEqual({ ok: true, requestId: REQ, nodeId: 'node-b', closed: true })
    expect(h.closed).toEqual(['node-a', 'node-b'])
  })
})
