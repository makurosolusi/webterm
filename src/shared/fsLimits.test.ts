import { describe, expect, it } from 'vitest'
import {
  FS_BODY_MAX,
  FS_READ_BINARY_MAX_BYTES,
  FS_READ_MAX_BYTES,
  formatBytes,
  tooLargeSentinel,
  tooLargeSize,
} from './fsLimits'

describe('limits', () => {
  it('keep the documented relationships', () => {
    expect(FS_READ_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(FS_READ_BINARY_MAX_BYTES).toBeGreaterThan(FS_READ_MAX_BYTES)
    expect(FS_BODY_MAX).toBe(FS_READ_MAX_BYTES * 2 + 64 * 1024)
  })
})

describe('too-large sentinel', () => {
  it('starts with a NUL byte and round-trips the size', () => {
    for (const n of [0, 1, FS_READ_MAX_BYTES + 1, 2 ** 40]) {
      const s = tooLargeSentinel(n)
      expect(s.charCodeAt(0)).toBe(0)
      expect(tooLargeSize(s)).toBe(n)
    }
  })
  it('is not confused with real content', () => {
    for (const s of ['', 'hello', 'webterm:too-large:5', '\u0000other:5', 'dGV4dA==']) expect(tooLargeSize(s)).toBeNull()
  })
  it('still recognises the pre-rename prefix but never emits it', () => {
    expect(tooLargeSize('\u0000nodeterm:too-large:42')).toBe(42)
    expect(tooLargeSentinel(42)).not.toContain('nodeterm')
  })
  it('rejects a sentinel whose size is not a number', () => {
    expect(tooLargeSize('\u0000webterm:too-large:abc')).toBeNull()
    expect(tooLargeSize('\u0000webterm:too-large:Infinity')).toBeNull()
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [1024 * 1024 - 1, '1024 KB'],
    [1024 * 1024, '1.0 MB'],
    [10.5 * 1024 * 1024, '10.5 MB'],
    [1024 ** 3, '1.0 GB'],
    [3.25 * 1024 ** 3, '3.3 GB'],
  ])('%i -> %s', (n, text) => {
    expect(formatBytes(n)).toBe(text)
  })
})
