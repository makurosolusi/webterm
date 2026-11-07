import { describe, expect, it } from 'vitest'
import { stderrReason } from './runtimeShared'

describe('stderrReason', () => {
  it('picks the last Error line, else the last non-empty line, redacted and capped', () => {
    expect(stderrReason('noise\nError: boom\nmore\n')).toBe('Error: boom')
    expect(stderrReason('one\n\ntwo\n  \n')).toBe('two')
    expect(stderrReason('')).toBe('')
    expect(stderrReason('Error: key sk-secret-123 bad', ['sk-secret-123'])).not.toContain('sk-secret-123')
    expect(stderrReason('x'.repeat(500)).length).toBe(200)
  })
})
