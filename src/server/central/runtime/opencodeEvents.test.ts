import { describe, expect, it } from 'vitest'
import { createOpencodeStreamParser, mapOpencodeRecord } from './opencodeEvents'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

describe('opencode JSONL parsing', () => {
  it('maps a text part to one full text.delta block and captures sessionID', () => {
    const parser = createOpencodeStreamParser()
    const events = parser.push(line({
      type: 'text', sessionID: 'ses_1', part: { id: 'p1', text: 'Hello there' },
    }))
    expect(events).toEqual([{ type: 'text', text: 'Hello there' }])
    expect(parser.sessionRef).toBe('ses_1')
  })

  it('emits a text block once per part id even when the CLI repeats it', () => {
    const parser = createOpencodeStreamParser()
    parser.push(line({ type: 'text', sessionID: 's', part: { id: 'p1', text: 'once' } }))
    const repeated = parser.push(line({ type: 'text', sessionID: 's', part: { id: 'p1', text: 'once' } }))
    expect(repeated).toEqual([])
  })

  it('reassembles records split across arbitrary chunks', () => {
    const parser = createOpencodeStreamParser()
    const payload = line({ type: 'text', sessionID: 's', part: { id: 'p1', text: 'split' } })
    const first = parser.push(payload.slice(0, 10))
    const second = parser.push(payload.slice(10))
    expect(first).toEqual([])
    expect(second).toEqual([{ type: 'text', text: 'split' }])
  })

  it('handles CRLF and flushes a trailing line without a newline', () => {
    const parser = createOpencodeStreamParser()
    const crlf = `${JSON.stringify({ type: 'text', sessionID: 's', part: { id: 'a', text: 'crlf' } })}\r\n`
    expect(parser.push(crlf)).toEqual([{ type: 'text', text: 'crlf' }])
    const trailing = JSON.stringify({ type: 'text', sessionID: 's', part: { id: 'b', text: 'tail' } })
    expect(parser.push(trailing)).toEqual([])
    expect(parser.end()).toEqual([{ type: 'text', text: 'tail' }])
  })

  it('maps tool_use to requested + completed with status and output', () => {
    const parser = createOpencodeStreamParser()
    const events = parser.push(line({
      type: 'tool_use',
      sessionID: 's',
      part: {
        callID: 'call_1',
        tool: 'portfolio.read',
        state: { status: 'completed', input: { scope: 'global' }, output: { items: 2 } },
      },
    }))
    expect(events).toEqual([
      { type: 'tool.requested', toolCallId: 'call_1', name: 'portfolio.read', input: { scope: 'global' } },
      {
        type: 'tool.completed', toolCallId: 'call_1', name: 'portfolio.read', ok: true,
        output: { items: 2 },
      },
    ])
  })

  it('marks a failed tool as completed with tool_failed', () => {
    const events = mapOpencodeRecord({
      type: 'tool_use',
      part: { callID: 'c2', tool: 'webfetch', state: { status: 'error', input: {}, error: 'nope' } },
    })
    expect(events[1]).toMatchObject({ type: 'tool.completed', ok: false, errorCode: 'tool_failed' })
  })

  it('maps step_finish tokens and cost into a usage delta', () => {
    const events = mapOpencodeRecord({
      type: 'step_finish',
      part: {
        cost: 0.00025,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      },
    })
    expect(events).toEqual([{
      type: 'usage',
      usage: {
        inputTokens: 10, outputTokens: 5, reasoningTokens: 2,
        cacheReadTokens: 3, cacheWriteTokens: 1, costMicros: 250,
      },
    }])
  })

  it('reports zero cost when the CLI omits it', () => {
    const [event] = mapOpencodeRecord({
      type: 'step_finish', part: { tokens: { input: 1, output: 1 } },
    })
    expect(event).toMatchObject({ type: 'usage', usage: { costMicros: 0 } })
  })

  it('maps error records to a runtime error', () => {
    const events = mapOpencodeRecord({
      type: 'error',
      error: { name: 'ProviderError', data: { message: 'upstream unavailable' } },
    })
    expect(events).toEqual([
      { type: 'error', code: 'runtime_error', message: 'upstream unavailable' },
    ])
  })

  it('ignores unknown events, non-objects, and invalid JSON', () => {
    const parser = createOpencodeStreamParser()
    const events = parser.push([
      line({ type: 'step_start', sessionID: 's', part: {} }),
      line({ type: 'mystery', payload: 1 }),
      line([1, 2, 3]),
      'not json\n',
      '\n',
      line({ type: 'text', sessionID: 's', part: { id: 'ok', text: 'kept' } }),
    ].join(''))
    expect(events).toEqual([{ type: 'text', text: 'kept' }])
    expect(parser.sessionRef).toBe('s')
  })

  it('skips oversized lines without breaking later records', () => {
    const parser = createOpencodeStreamParser()
    const huge = `{"type":"text","part":{"id":"huge","text":"${'x'.repeat(4 * 1024 * 1024 + 64)}"}}`
    expect(parser.push(`${huge}\n`)).toEqual([])
    expect(parser.push(line({ type: 'text', sessionID: 's', part: { id: 'after', text: 'ok' } })))
      .toEqual([{ type: 'text', text: 'ok' }])
  })
})
