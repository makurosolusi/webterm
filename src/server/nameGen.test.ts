import { describe, expect, it } from 'vitest'
import { clipTerminal, buildNamePrompt, buildTaskNamePrompt, cleanName, firstPromptFromTranscript, titleFromPrompt } from './nameGen'

describe('firstPromptFromTranscript', () => {
  const jl = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join('\n')
  it('returns the first real user prompt, skipping meta, webterm notes, command wrappers and tool results', () => {
    const raw = jl(
      { type: 'summary' },
      { type: 'user', isMeta: true, message: { content: 'Caveat: meta' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: '[webterm] You are now linked to node x' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'Fix the login redirect bug' }] } },
      { type: 'user', message: { content: 'second prompt' } },
    )
    expect(firstPromptFromTranscript(raw)).toBe('Fix the login redirect bug')
  })
  it('empty / garbage → empty', () => {
    expect(firstPromptFromTranscript('')).toBe('')
    expect(firstPromptFromTranscript('not json\n{')).toBe('')
  })
})

describe('buildTaskNamePrompt', () => {
  it('embeds the request with an Orca-style instruction', () => {
    const p = buildTaskNamePrompt('  add dark mode  ')
    expect(p).toContain('User request:\nadd dark mode')
    expect(p).toContain('Output ONLY the title')
  })
})

describe('titleFromPrompt', () => {
  it('short prompt kept as-is minus trailing punctuation', () => {
    expect(titleFromPrompt('Fix the login bug.')).toBe('Fix the login bug')
  })
  it('long prompt cut at a word boundary within 40 chars, first line only', () => {
    const t = titleFromPrompt('Refactor the websocket reconnect logic so that it backs off exponentially\nmore')
    expect(t.length).toBeLessThanOrEqual(40)
    expect(t).toBe('Refactor the websocket reconnect logic')
  })
})

describe('clipTerminal', () => {
  it('keeps only the last 150 lines', () => {
    const input = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    expect(clipTerminal(input).split('\n')).toHaveLength(150)
  })
  it('caps at 8000 chars', () => {
    const input = 'x'.repeat(9000)
    expect(clipTerminal(input).length).toBeLessThanOrEqual(8000)
  })
  it('whitespace-only -> empty', () => {
    expect(clipTerminal('   \n  \t\n')).toBe('')
  })
})

describe('buildNamePrompt', () => {
  it('embeds clip + instruction + fenced block', () => {
    const p = buildNamePrompt('npm test')
    expect(p).toContain('npm test')
    expect(p).toContain('2-4 words, Title Case')
    expect(p).toContain('```')
  })
})

describe('cleanName', () => {
  it('takes first line only', () => {
    expect(cleanName('Build Server\njunk')).toBe('Build Server')
  })
  it('strips trailing quotes and punctuation', () => {
    expect(cleanName('Deploy Script".')).toBe('Deploy Script')
  })
  it('caps at 40 chars', () => {
    expect(cleanName('a'.repeat(60)).length).toBe(40)
  })
  it('empty -> empty', () => {
    expect(cleanName('')).toBe('')
  })
})
