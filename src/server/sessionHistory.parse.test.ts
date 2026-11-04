import { describe, expect, it } from 'vitest'
import { consumeLine, isInjectedTurn, newParseState, sessionIdFromFile, TITLE_MAX } from './sessionHistory.parse'

const line = (r: unknown) => JSON.stringify(r)
const feed = (agent: 'claude' | 'codex', lines: string[], id = 'f') => {
  const s = newParseState(agent, id)
  for (const l of lines) consumeLine(s, l)
  return s
}

describe('claude transcript', () => {
  it('title is the first REAL user prompt: meta, harness tags and [webterm] notes are skipped', () => {
    const s = feed('claude', [
      line({ type: 'user', isMeta: true, cwd: '/repo', timestamp: '2026-01-01T10:00:00Z', message: { content: 'caveat meta' } }),
      line({ type: 'user', timestamp: '2026-01-01T10:00:01Z', message: { content: '<system-reminder>x</system-reminder>' } }),
      line({ type: 'user', timestamp: '2026-01-01T10:00:02Z', message: { content: [{ type: 'text', text: '[webterm] You are now linked to node B' }] } }),
      line({ type: 'user', timestamp: '2026-01-01T10:00:03Z', message: { content: [{ type: 'text', text: '  fix the\n login bug ' }] } }),
      line({ type: 'assistant', timestamp: '2026-01-01T10:05:00Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
      line({ type: 'summary', summary: 'not a message' }),
    ])
    expect(s.title).toBe('fix the login bug')
    expect(s.cwd).toBe('/repo')
    expect(s.messageCount).toBe(5)
    expect(s.startedAt).toBe(Date.parse('2026-01-01T10:00:00Z'))
    expect(s.endedAt).toBe(Date.parse('2026-01-01T10:05:00Z'))
  })

  it('broken and empty lines are ignored, the rest still counts', () => {
    const s = feed('claude', ['{"type":"user","mess', '', line({ type: 'assistant', message: {} })])
    expect(s.messageCount).toBe(1)
    expect(s.title).toBeNull()
  })

  it('long prompts are cut to TITLE_MAX', () => {
    const s = feed('claude', [line({ type: 'user', message: { content: 'a'.repeat(500) } })])
    expect(s.title).toHaveLength(TITLE_MAX)
  })
})

describe('codex transcript', () => {
  it('reads id/cwd from session_meta, skips environment_context, counts response_item messages once', () => {
    const s = feed('codex', [
      line({ timestamp: '2026-05-01T10:00:00Z', type: 'session_meta', payload: { id: 'cdx-1', cwd: '/repo/app' } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add tests' }] } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'add tests' } }),
      line({ timestamp: '2026-05-01T10:01:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'done' } }),
    ], 'from-file')
    expect(s).toMatchObject({ id: 'cdx-1', cwd: '/repo/app', title: 'add tests', messageCount: 3 })
  })

  it('falls back to event_msg user_message for the title', () => {
    const s = feed('codex', [line({ type: 'event_msg', payload: { type: 'user_message', message: 'legacy prompt' } })])
    expect(s.title).toBe('legacy prompt')
  })
})

describe('helpers', () => {
  it('isInjectedTurn keeps unknown tags as real input', () => {
    expect(isInjectedTurn('<command-name>/clear</command-name>')).toBe(true)
    expect(isInjectedTurn('<div>layout question</div>')).toBe(false)
    expect(isInjectedTurn('[nodeterm] linked')).toBe(true)
  })

  it('sessionIdFromFile', () => {
    expect(sessionIdFromFile('claude', 'abc-123.jsonl')).toBe('abc-123')
    expect(sessionIdFromFile('codex', 'rollout-2026-05-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'))
      .toBe('019f0000-1111-7222-8333-444444444444')
  })
})
