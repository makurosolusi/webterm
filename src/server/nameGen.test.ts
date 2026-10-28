import { describe, expect, it } from 'vitest'
import { clipTerminal, buildNamePrompt, cleanName } from './nameGen'

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
