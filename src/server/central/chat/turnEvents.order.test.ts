import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../runtime/centralRuntime'
import { createRunState, projectRuntimeEvent, type RunState } from './turnEvents'
import { assistantParts } from './turnPersistence'

let seq = 0
/** Projects one runtime event; the envelope fields (turn, seq, time) are irrelevant to part order. */
function feed(state: RunState, event: Record<string, unknown>): void {
  projectRuntimeEvent(state, 'm1', { turnId: 't', seq: ++seq, at: seq, ...event } as RuntimeEvent)
}

describe('assistant parts keep event order', () => {
  it('persists text → tools → text as separate parts, not one glued text with tools at the end', () => {
    const state = createRunState()
    feed(state, { type: 'text.delta', text: 'I will close it' })
    feed(state, { type: 'text.delta', text: ' now.' })
    feed(state, { type: 'tool.requested', toolCallId: 't1', name: 'node_close', input: {} })
    feed(state, { type: 'tool.completed', toolCallId: 't1', name: 'node_close', ok: true, output: {}, durationMs: 1 })
    feed(state, { type: 'tool.requested', toolCallId: 't2', name: 'canvas_list', input: {} })
    feed(state, { type: 'tool.completed', toolCallId: 't2', name: 'canvas_list', ok: false, output: {}, durationMs: 1 })
    feed(state, { type: 'text.delta', text: 'Canvas is empty.' })

    const parts = assistantParts(state, 'I will close it now.Canvas is empty.', null, () => 'awaiting_approval')
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'tool', 'text'])
    expect(parts[0]).toMatchObject({ text: 'I will close it now.' })
    expect(parts[1]).toMatchObject({ toolCallId: 't1', state: 'succeeded' })
    expect(parts[2]).toMatchObject({ toolCallId: 't2', state: 'failed' })
    expect(parts[3]).toMatchObject({ text: 'Canvas is empty.' })
  })

  it('falls back to the final text ahead of the tools when nothing streamed', () => {
    const state = createRunState()
    feed(state, { type: 'tool.requested', toolCallId: 't1', name: 'x', input: {} })
    const parts = assistantParts(state, 'final', null, () => 'awaiting_approval')
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool'])
  })
})
