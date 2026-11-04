import { describe, expect, it } from 'vitest'
import { uniqueTitle } from './nodeTitle'
import { uniqueTitle as fromClient } from '../client/nodeIdentity'

describe('uniqueTitle (shared)', () => {
  it('suffixes duplicates case-insensitively and skips taken suffixes', () => {
    expect(uniqueTitle('Fix bug', [])).toBe('Fix bug')
    expect(uniqueTitle('Fix bug', [' fix BUG '])).toBe('Fix bug (2)')
    expect(uniqueTitle('Fix bug', ['Fix bug', 'fix bug (2)'])).toBe('Fix bug (3)')
  })

  it('is the same function the canvas uses (one implementation)', () => {
    expect(fromClient).toBe(uniqueTitle)
  })
})
