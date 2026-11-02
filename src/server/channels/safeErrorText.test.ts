import { describe, expect, it } from 'vitest'
import { safeErrorText } from './safeErrorText'

describe('safeErrorText', () => {
  it('uses an Error message, a string as-is, and the fallback for anything else', () => {
    expect(safeErrorText(new Error('boom'), 'fb')).toBe('boom')
    expect(safeErrorText('plain', 'fb')).toBe('plain')
    expect(safeErrorText({ a: 1 }, 'fb')).toBe('fb')
    expect(safeErrorText(undefined, 'outbox unavailable')).toBe('outbox unavailable')
  })
  it('scrubs a bot token embedded in a URL', () => {
    const out = safeErrorText(new Error('GET https://api.telegram.org/bot123456:ABCdefGhIJKlmNoPQRsTUVwxyZ/sendMessage failed'), 'fb')
    expect(out).not.toContain('ABCdefGhIJKlmNoPQRsTUVwxyZ')
  })
  it('truncates to 200 chars by default and to the given cap', () => {
    expect(safeErrorText('x'.repeat(500), 'fb').length).toBe(200)
    expect(safeErrorText('x'.repeat(500), 'fb', 10)).toBe('x'.repeat(10))
  })
})
